import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	VersionedTransaction,
	SignatureResult,
	Transaction,
	BlockhashWithExpiryBlockHeight,
	TransactionMessage
} from '@solana/web3.js';
import {
	SearcherClient,
	searcherClient,
} from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import { BundleResult } from 'jito-ts/dist/gen/block-engine/bundle';
import WebSocket from 'ws';
import bs58 from 'bs58';
import { TransactionExecutor } from './transaction-executor.interface'

import {
	ClientDuplexStream
} from "@grpc/grpc-js";
import transaction from '@coral-xyz/anchor/dist/cjs/program/namespace/transaction';

export const jitoBundlePriceEndpoint =
	'ws://bundles-api-rest.jito.wtf/api/v1/bundles/tip_stream';

const logPrefix = '[BundleSender]';

export type TipStream = {
	time: string;
	ts: number; // millisecond timestamp
	landed_tips_25th_percentile: number; // in SOL
	landed_tips_50th_percentile: number; // in SOL
	landed_tips_75th_percentile: number; // in SOL
	landed_tips_95th_percentile: number; // in SOL
	landed_tips_99th_percentile: number; // in SOL
	ema_landed_tips_50th_percentile: number; // in SOL
};

export type DropReason = 'pruned' | 'blockhash_expired' | 'blockhash_not_found';

export type BundleStats = {
	accepted: number;
	stateAuctionBidRejected: number;
	winningBatchBidRejected: number;
	simulationFailure: number;
	internalError: number;
	droppedBundle: number;

	/// extra stats
	droppedPruned: number;
	droppedBlockhashExpired: number;
	droppedBlockhashNotFound: number;
};

const validatorCounter = {
	"confirmSignatureViaHttp": 0,
	"confirmSignatureViaSocket": 0,
	"confirmSignatureViaGetTx": 0,
	"confirmSignatureViaGeyser": 0,
	"confirmSignatureViaBundleResult": 0,
}

export class JitoTransactionExecutor implements TransactionExecutor {
	private ws: WebSocket | undefined;
	private searcherClient: SearcherClient;
	private leaderScheduleIntervalId: NodeJS.Timeout | undefined;
	private checkSentTxsIntervalId: NodeJS.Timeout | undefined;
	private isSubscribed = false;
	private shuttingDown = false;
	private jitoTipAccounts: PublicKey[] = [];
	private nextJitoLeader?: {
		currentSlot: number;
		nextLeaderSlot: number;
		nextLeaderIdentity: string;
	};
	private updatingJitoSchedule = false;
	private checkingSentTxs = false;

	// if there is a big difference, probably jito ws connection is bad, should resub
	private bundlesSent = 0;
	private bundleResultsReceived = 0;

	// // `bundleIdToTx` will be populated immediately after sending a bundle.
	// private bundleIdToTx: LRUCache<string, { tx: string; ts: number }>;
	// // `sentTxCache` will only be populated after a bundle result is received.
	// // reason being that sometimes results come really late (like minutes after sending)
	// // unsure if this is a jito issue or this bot is inefficient and holding onto things
	// // for that long. Check txs from this map to see if they landed.
	// private sentTxCache: LRUCache<string, number>;

	/// -1 for each accepted bundle, +1 for each rejected (due to bid, don't count sim errors).
	private failBundleCount = 0;
	private countLandedBundles = 0;
	private countDroppedbundles = 0;

	private lastTipStream: TipStream | undefined;
	private bundleStats: BundleStats = {
		accepted: 0,
		stateAuctionBidRejected: 0,
		winningBatchBidRejected: 0,
		simulationFailure: 0,
		internalError: 0,
		droppedBundle: 0,

		// custom stats
		droppedPruned: 0,
		droppedBlockhashExpired: 0,
		droppedBlockhashNotFound: 0,
	};


	constructor(
		private connection: Connection,
		jitoBlockEngineUrl: string,
		jitoAuthKeypair: Keypair,
		private tipPayerKeypair: Keypair,
		//private slotSubscriber: SlotSubscriber,

		/// tip algo params
		public strategy: 'non-jito-only' | 'jito-only' | 'hybrid' = 'jito-only',
		private minBundleTip = 1_000_000, // 0.001 SOL  
		private maxBundleTip = 10_000_000, // 0.01 SOL
		private maxFailBundleCount = 100, // at 100 failed txs, can expect tip to become maxBundleTip
		private tipMultiplier = 3 // bigger == more superlinear, delay the ramp up to prevent overpaying too soon
	) {
		this.searcherClient = searcherClient(jitoBlockEngineUrl, jitoAuthKeypair, {
			// Send keepalive pings every 10 seconds, default is 2 hours.
			'grpc.keepalive_time_ms': 10 * 1000,
			// Keepalive ping timeout after 5 seconds, default is 20 seconds.
			'grpc.keepalive_timeout_ms': 5 * 1000,
			// Allow keepalive pings when there are no gRPC calls.
			'grpc.keepalive_permit_without_calls': 1,
			"grpc.max_receive_message_length": -1,
			"grpc.max_send_message_length": -1,
		});

	}

	// slotsUntilNextLeader(): number | undefined {
	// 	if (!this.nextJitoLeader) {
	// 		return undefined;
	// 	}
	// 	return this.nextJitoLeader.nextLeaderSlot - this.slotSubscriber.getSlot();
	// }

	getBundleStats(): BundleStats {
		return this.bundleStats;
	}

	getTipStream(): TipStream | undefined {
		return this.lastTipStream;
	}

	getBundleFailCount(): number {
		return this.failBundleCount;
	}

	getLandedCount(): number {
		return this.countLandedBundles;
	}

	getDroppedCount(): number {
		return this.countDroppedbundles;
	}

	private incRunningBundleScore(amount = 1) {
		this.failBundleCount =
			(this.failBundleCount + amount) % this.maxFailBundleCount;
	}

	private decRunningBundleScore(amount = 1) {
		this.failBundleCount = Math.max(this.failBundleCount - amount, 0);
	}

	private handleBundleResult(bundleResult: BundleResult) {
		if (bundleResult.accepted !== undefined) {
			this.bundleStats.accepted++;
		} else if (bundleResult.rejected !== undefined) {
			if (bundleResult.rejected.droppedBundle !== undefined) {
				this.bundleStats.droppedBundle++;
				const msg = bundleResult.rejected.droppedBundle.msg;
				if (msg.includes('pruned at slot')) {
					this.bundleStats.droppedPruned++;
				} else if (msg.includes('blockhash has expired')) {
					this.bundleStats.droppedBlockhashExpired++;
				} else if (msg.includes('Blockhash not found')) {
					this.bundleStats.droppedBlockhashNotFound++;
				}
			} else if (bundleResult.rejected.internalError !== undefined) {
				this.bundleStats.internalError++;
			} else if (bundleResult.rejected.simulationFailure !== undefined) {
				this.bundleStats.simulationFailure++;
			} else if (bundleResult.rejected.stateAuctionBidRejected !== undefined) {
				this.bundleStats.stateAuctionBidRejected++;
			} else if (bundleResult.rejected.winningBatchBidRejected !== undefined) {
				this.bundleStats.winningBatchBidRejected++;
			}
		}
	}

	private connectJitoTipStream() {
		if (this.ws !== undefined) {
			// logger.warn(
			// 	`${logPrefix} Called connectJitoTipStream but this.ws is already connected, disconnecting it...`
			// );
			this.ws.close();
			return;
		}

		this.ws = new WebSocket(jitoBundlePriceEndpoint);
		this.bundlesSent = 0;
		this.bundleResultsReceived = 0;

		this.ws.on('message', (data: string) => {
			const tipStream = JSON.parse(data) as Array<TipStream>;
			if (tipStream.length > 0) {
				tipStream[0].ts = new Date(tipStream[0].time).getTime();
				this.lastTipStream = tipStream[0];
				// logger.info(`${logPrefix}: currentTipAmount: ${this.calculateCurrentTipAmount()}, lastJitoTipStream: ${JSON.stringify(this.lastTipStream)}`);
			}
		});
		this.ws.on('close', () => {
			// logger.info(
			// 	`${logPrefix}: jito ws closed ${this.shuttingDown ? 'shutting down...' : 'reconnecting in 5s...'
			// 	}`
			// );
			this.ws = undefined;
			if (!this.shuttingDown) {
				setTimeout(this.connectJitoTipStream.bind(this), 5000);
			}
		});
		this.ws.on('error', (e) => {
			// logger.error(`${logPrefix}: jito ws error: ${JSON.stringify(e)}`);
		});
	}

	public async subscribe(): Promise<void> {
		if (this.isSubscribed) {
			return;
		}
		this.isSubscribed = true;
		this.shuttingDown = false;

		const tipAccounts = await this.searcherClient.getTipAccounts();
		this.jitoTipAccounts = tipAccounts.map((k) => new PublicKey(k));
		this.connectJitoTipStream();

		// this.searcherClient.onBundleResult(
		// 	(bundleResult: BundleResult) => {
		// 		logger.debug(
		// 			`${logPrefix}: got bundle result:\n${JSON.stringify(bundleResult)}`
		// 		);
		// 		this.bundleResultsReceived++;
		// 		this.handleBundleResult(bundleResult);
		// 	},
		// 	(e) => {
		// 		const err = e as Error;
		// 		logger.error(
		// 			`${logPrefix}: error getting bundle result: ${err.message}: ${e.stack}`
		// 		);
		// 	}
		// );

		// this.slotSubscriber.eventEmitter.on(
		// 	'newSlot',
		// 	this.onSlotSubscriberSlot.bind(this)
		// );
		// this.leaderScheduleIntervalId = setInterval(
		// 	this.updateJitoLeaderSchedule.bind(this),
		// 	1000
		// );

	}

	async unsubscribe() {
		if (!this.isSubscribed) {
			return;
		}
		this.shuttingDown = true;

		if (this.ws) {
			this.ws.close();
		}

		if (this.leaderScheduleIntervalId) {
			clearInterval(this.leaderScheduleIntervalId);
			this.leaderScheduleIntervalId = undefined;
		}

		if (this.checkSentTxsIntervalId) {
			clearInterval(this.checkSentTxsIntervalId);
			this.checkSentTxsIntervalId = undefined;
		}

		this.isSubscribed = false;
	}

	private isSignatureResult(result: SignatureResult | BundleResult): result is SignatureResult {
		return (result as SignatureResult).err !== undefined;
	}

	public async executeAndConfirm(
		tx: Transaction,
		// transaction: VersionedTransaction,
		payer: Keypair,
		latestBlockHash: BlockhashWithExpiryBlockHeight,
	): Promise<{ confirmed: boolean; signature?: string, error?: string }> {

		console.log({
			feePayer: tx.feePayer,
			recentBlockhash: tx.recentBlockhash,
			instructions: tx.instructions
		})

		//creating versionedTx
		const messageV0 = new TransactionMessage({
			payerKey: tx.feePayer!,
			recentBlockhash: tx.recentBlockhash!,
			//instructions: [...tx.instructions],
			instructions: tx.instructions
		}).compileToV0Message();


		const vTransaction = new VersionedTransaction(messageV0);
		const txSignature = bs58.encode(vTransaction.signatures[0]);
		vTransaction.sign([payer]);

		console.log(`Buy Transaction sent: https://solscan.io/tx/${txSignature}`);

		try {

			const uuid = await this.sendTransaction(vTransaction, latestBlockHash, txSignature);
			console.log("Transaction sent with uuid: ", uuid);
			console.log("Transaction signature: ", txSignature);



		} catch (error) {
			const err = error as Error;
			console.error(err.message);
		}

		return { confirmed: true, signature: txSignature };
	}


	// const confirmSignatureViaHttp = this.connection.confirmTransaction(
	// 	{
	// 		signature: txSignature,
	// 		blockhash: latestBlockHash.blockhash,
	// 		lastValidBlockHeight: Number(latestBlockHash.lastValidBlockHeight)
	// 	},
	// 	this.connection.commitment
	// ).then((result) => {
	// 	if (!result.value.err) {
	// 		console.log("Validated using confirmSignatureViaHttp")
	// 		validatorCounter.confirmSignatureViaHttp++;
	// 	}
	// 	return result.value
	// });

	// const confirmSignatureViaSocket = new Promise<SignatureResult>((resolve) =>
	// 	this.connection.onSignature(txSignature, (signatureResult) => {
	// 		if (!signatureResult.err) {
	// 			console.log("Validated using confirmSignatureViaSocket")
	// 			validatorCounter.confirmSignatureViaSocket++;
	// 			resolve({ err: null })
	// 		}
	// 	})
	// );

	// const confirmSignatureViaGetTx = new Promise<SignatureResult>((resolve) => {
	// 	this.connection.getTransaction(txSignature, { commitment: 'confirmed' }).then((txResult) => {
	// 		if (txResult) {
	// 			console.log("Validated using confirmSignatureViaGetTx")
	// 			validatorCounter.confirmSignatureViaGetTx++;
	// 			resolve({ err: null })
	// 		}
	// 	})
	// });

	// const signatureSub = await geyserConnection!.subscribeToSignature(txSignature)
	// const confirmSignatureViaGeyser = new Promise<SignatureResult>((resolve) => {
	// 	signatureSub.on('data', async (updatedAccountInfo: any) => {
	// 		console.log({
	// 			updatedAccountInfo
	// 		})
	// 		if (updatedAccountInfo && updatedAccountInfo.transactionStatus && !updatedAccountInfo.transactionStatus.err) {
	// 			console.log("Validated using confirmSignatureViaGeyser")
	// 			validatorCounter.confirmSignatureViaGeyser++;
	// 			resolve({ err: null })
	// 		}
	// 	});
	// 	signatureSub.on('error', (error: any) => {
	// 		console.error("Stream error:", error);
	// 	});
	// 	signatureSub.on('end', () => {
	// 		console.log("Stream ended");
	// 	});
	// });

	// const confirmSignatureViaBundleResult = new Promise<SignatureResult>((resolve) => {
	// 	this.searcherClient.onBundleResult(
	// 		(result) => {
	// 			if (result.accepted) {
	// 				console.log("Validated using confirmSignatureViaBundleResult")
	// 				logger.debug(
	// 					`${logPrefix}: got bundle result:\n${JSON.stringify(result)}`
	// 				);
	// 				this.handleBundleResult(result);
	// 				validatorCounter.confirmSignatureViaBundleResult++;
	// 				resolve({ err: null })
	// 			}
	// 		},
	// 		(e: Error) => {
	// 			logger.error(
	// 				`${logPrefix}: error getting bundle result: ${e.message}: ${e.stack}`
	// 			);
	// 		}
	// 	);
	// });

	// 	while (!confirmedTx) {
	// 		try {
	// 			confirmedTx = await Promise.race([
	// 				confirmSignatureViaHttp,
	// 				confirmSignatureViaSocket,
	// 				confirmSignatureViaGetTx,
	// 				confirmSignatureViaGeyser,
	// 				confirmSignatureViaBundleResult,
	// 				new Promise<null>((resolve) =>
	// 					setTimeout(() => {
	// 						resolve(null);
	// 					}, 2000)
	// 				),
	// 			]);
	// 			if (confirmedTx && confirmedTx.err === null) {
	// 				succes = true;
	// 				await landedTxCounter.inc(1)
	// 				//fs.writeFileSync("./validations.json", JSON.stringify(validatorCounter));
	// 				signatureSub.destroy()
	// 				break;
	// 			}
	// 			if (maxRetries < retryCount) {
	// 				succes = false;
	// 				signatureSub.destroy()
	// 				break;
	// 			}
	// 			console.log(
	// 				"Retrying transaction ",
	// 				" with signature: ",
	// 				txSignature,
	// 				" Retry count: ",
	// 				retryCount
	// 			);
	// 			retryCount++;

	// 			const uuid = await this.sendTransaction(transaction, latestBlockHash, txSignature);
	// 			await sendTxCounter.inc(1);
	// 			if (uuid.error?.includes(("bundle contains an already processed transaction"))) {
	// 				succes = true;
	// 				await landedTxCounter.inc(1)
	// 				signatureSub.destroy()
	// 				break;
	// 			}
	// 			logger.info(
	// 				`Sent bundle with uuid ${uuid} (${txSignature}: ${Date.now()})`
	// 			);
	// 		} catch (error) {
	// 			const err = error as Error;
	// 			if (err.message.includes("bundle contains an already processed transaction")) {
	// 				succes = true;
	// 				await landedTxCounter.inc(1)
	// 				signatureSub.destroy()
	// 				break;
	// 			} else {
	// 				logger.error(`Transaction ${txSignature} has failed with error:${err.message}`);
	// 				succes = false;
	// 				signatureSub.destroy()
	// 				break;
	// 			}
	// 		}
	// 	}
	// 	if (confirmedTx?.err) {
	// 		logger.info(
	// 			`Transaction ${txSignature} has failed with error: ${JSON.stringify(
	// 				confirmedTx.err
	// 			)}`
	// 		);
	// 		signatureSub.destroy()
	// 		return { confirmed: false, signature: txSignature, error: confirmedTx.err.toString() };
	// 	}
	// 	console.table(this.bundleStats);
	// 	signatureSub.destroy()
	// 	return { confirmed: succes, signature: txSignature};

	// } catch (error) {
	// 	const err = error as Error;
	// 	logger.error(err.message);
	// 	console.table(this.bundleStats);
	// 	return { confirmed: false, signature: txSignature, error: err.message };
	// }
	//}







	// calculateCurrentTipAmount() {
	// 	return Math.floor(
	// 		Math.max(
	// 			this.lastTipStream?.landed_tips_75th_percentile ?? 0 * LAMPORTS_PER_SOL,
	// 			this.maxBundleTip,
	// 			//this.maxBundleTip
	// 			// Math.min(
	// 			// 	this.maxBundleTip,
	// 			// 	Math.pow(
	// 			// 		this.failBundleCount / this.maxFailBundleCount,
	// 			// 		this.tipMultiplier
	// 			// 	) * this.maxBundleTip
	// 			// )
	// 		)
	// 	);
	// }

	private async sendTransaction(
		signedTx: VersionedTransaction,
		latestBlockHash: BlockhashWithExpiryBlockHeight,
		txSig?: string
	): Promise<{ bundleID?: string, error?: string }> {

		if (!this.isSubscribed) {
			// logger.warn(
			// 	`${logPrefix} You should call bundleSender.subscribe() before sendTransaction()`
			// );
			await this.subscribe();
			throw new Error('Subscription required before sending transactions');
		}

		this.bundlesSent++;

		const tipAccountToUse =
			this.jitoTipAccounts[
			Math.floor(Math.random() * this.jitoTipAccounts.length)
			];

		let b: Bundle | Error = new Bundle([signedTx], 2).addTipTx(
			this.tipPayerKeypair,
			Math.round((this.getTipStream()?.landed_tips_95th_percentile ?? 0.01) * LAMPORTS_PER_SOL),
			//25000000,
			tipAccountToUse,
			latestBlockHash.blockhash
		);

		if (b instanceof Error) {
			// logger.error(`${logPrefix} failed to attach tip: ${b.message})`);
			throw new Error('Failed to create bundle');
		}

		try {
			if (!txSig) {
				txSig = bs58.encode(signedTx.signatures[0]);
			}
			const bundleId = await this.searcherClient.sendBundle(b);
			// logger.info(
			// 	`${logPrefix} sent bundle with uuid ${bundleId} (${txSig}: ${Date.now()})`
			// );
			return { bundleID: bundleId };
		} catch (e) {
			const err = e as Error;
			return { error: err.message };
		}
	}
}