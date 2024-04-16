
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, sendAndConfirmRawTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import base58 from "bs58";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { Transaction, ComputeBudgetProgram, } from "@solana/web3.js";
import readline from 'readline'
import { SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { isError } from "jito-ts/dist/sdk/block-engine/utils";
import { BundleResult } from "jito-ts/dist/gen/block-engine/bundle";
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";
import * as anchor from '@coral-xyz/anchor';

export async function send_transactions(
    Transactions: Transaction[],
    connection: Connection
) {
    try {
        var staggeredTransactions: Promise<string>[] = []
        var i = 1
        Transactions.forEach((tx, idx) => {
            const prms = new Promise<string>((resolve) => {
                setTimeout(() => {
                    sendAndConfirmRawTransaction(connection, tx.serialize(), { skipPreflight: true, commitment: 'processed', maxRetries: 2 })
                        .then(async (sig) => {
                            //console.log(`Transaction successful.`)
                            resolve(sig);
                        })
                        .catch(error => {
                            //console.log('Transaction failed :c')
                            resolve('failed');
                        })
                }, 100 * i)
            })
            staggeredTransactions.push(prms);
            i += 1
        })
        const result = await Promise.allSettled(staggeredTransactions)
        const values = []
        for (var entry of result) {
            //@ts-ignore      
            values.push(entry.value)
        }
        return values

    } catch (e) {
        return ['failed'];
    }
};

export function getRandomNumber() {
    // Generate a random number between 0 and 1
    var randomNumber = Math.random();

    // Scale the random number to the desired range (1 to 5000)
    var scaledNumber = Math.floor(randomNumber * 5000) + 1;

    return scaledNumber;
}


export function getCurrentDateTime(): string {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `[${date} ${hours}:${minutes}:${seconds}]`;
}

export function roundUpToNonZeroString(num: number): string {
    const numString = num.toString();
    const decimalIndex = numString.indexOf('.');

    if (decimalIndex === -1) {
        return numString;
    } else {
        const integerPart = numString.substring(0, decimalIndex);

        let decimalPart = numString.substring(decimalIndex + 1);
        decimalPart = decimalPart.replace(/0+$/, '');

        return decimalPart === '' ? integerPart : integerPart + '.' + decimalPart;
    }
}

export function getKeypairFromBs58(bs58String: string): Keypair {
    const privateKeyObject = base58.decode(bs58String);
    const privateKey = Uint8Array.from(privateKeyObject);
    const keypair = Keypair.fromSecretKey(privateKey);
    return keypair
}

export function generate_transactions(serializedTransactions: Array<string>) {
    const transactionBuffers = serializedTransactions
        .map((transaction) => Buffer.from(transaction, 'base64'));
    const rawTransactions = transactionBuffers
        .map((transactionBuffer) => Transaction.from(transactionBuffer));
    return rawTransactions;
}

export function serializeTransactions(rawTxs: Transaction[]) {
    return rawTxs.map((trans: Transaction) => {
        const temp = trans.serialize({ requireAllSignatures: false, verifySignatures: false })
        return Buffer.from(temp).toString('base64');
    })
}

export async function getComputeUnitsForTransaction(tx: Transaction, connection: Connection) {
    try {
        const newTx = new Transaction();
        newTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }));
        newTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
        newTx.add(...tx.instructions);
        newTx.recentBlockhash = tx.recentBlockhash;
        newTx.lastValidBlockHeight = tx.lastValidBlockHeight;
        newTx.feePayer = tx.feePayer;
        const simulation = await connection.simulateTransaction(newTx);

        if (simulation.value.err) {
            return 0;
        }
        return simulation.value.unitsConsumed ?? 200_000;

    } catch (e) {
        console.log(e);
        return 0
    }
}
export async function getPriorityFeeEstimateForTransaction(tx: Transaction) {
    try {
        const endpoint = process.env.RPC_URL as string;
        const jsonPayload = {
            jsonrpc: '2.0',
            id: '1',
            method: 'getPriorityFeeEstimate',
            params: [
                {
                    transaction: bs58.encode(tx.serialize({ verifySignatures: false, requireAllSignatures: false })), // Pass the serialized transaction in Base58
                    options: { includeAllPriorityFeeLevels: true },
                },
            ]
        }
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(jsonPayload)
        }).then(res => res.json());

        //const highFee = res.result.priorityFeeLevels.high as number;
        const veryHighFee = res.result.priorityFeeLevels.veryHigh as number;
        const finalFee = Math.min(Math.floor((veryHighFee * 2)), 20_000_000);
        return finalFee;

    } catch (e) {
        console.log(e);
        return 1000000;
    }
}
export async function getOptimalPriceAndBudget(hydratedTransaction: Transaction, connection: Connection) {

    const [priorityFee, ComputeUnits] = await Promise.all([
        getPriorityFeeEstimateForTransaction(hydratedTransaction),
        getComputeUnitsForTransaction(hydratedTransaction, connection),
    ])
    return [priorityFee, ComputeUnits];
}
export async function ConstructOptimalTransaction(prevTx: Transaction, connection: Connection, fee: number): Promise<Transaction> {

    const microLamports = fee == -1 ? await 1_000_000 : fee;
    const units = 59_000 + getRandomNumber();
    //getComputeUnitsForTransaction(prevTx, connection);
    //console.log(`Compute units to consume: ${units}`);
    //console.log(`Micro-lamports per compute unit: ${fee}\n`)

    const newTx = new Transaction();
    newTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    newTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
    newTx.add(...prevTx.instructions);
    newTx.recentBlockhash = prevTx.recentBlockhash;
    newTx.lastValidBlockHeight = prevTx.lastValidBlockHeight;
    newTx.feePayer = prevTx.feePayer;
    return newTx;
}


export function validateSolAddress(address: string) {
    try {
        let pubkey = new PublicKey(address)
        let isSolana = PublicKey.isOnCurve(pubkey.toBuffer())
        return isSolana
    } catch (error) {
        return false
    }
}


//parsing signatures
export async function parseSignatures(connection: Connection, signatures: string[]) {
    const parsedSignatures = await connection.getParsedTransactions(signatures, { maxSupportedTransactionVersion: 2 });
    return parsedSignatures
}


export const getUserInput = (prompt: string): Promise<string> => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(prompt, (userInput) => {
            resolve(userInput);
            rl.close();
        });
    });
};

//sleep function
export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


export async function buildBundle(
    search: SearcherClient,
    bundleTransactionLimit: number,
    tx: Transaction,
    signer: Keypair,
    tip: number,
) {

    //console.log("tip account:", _tipAccount);
    const tipAccount = new PublicKey((await search.getTipAccounts())[0]);
    const bund = new Bundle([], bundleTransactionLimit);



    const tipIx = SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: tipAccount,
        lamports: Math.max(Math.floor(tip * LAMPORTS_PER_SOL), 5001),
    })

    //creating versionedTx
    const messageV0 = new TransactionMessage({
        payerKey: tx.feePayer!,
        recentBlockhash: tx.recentBlockhash!,
        instructions: [...tx.instructions, tipIx],
    }).compileToV0Message();


    const vTransaction = new VersionedTransaction(messageV0);
    vTransaction.sign([signer]);

    const buildBundle = bund.addTransactions(vTransaction);


    if (isError(buildBundle)) {
        console.log('Error while creating bundle');
        //console.log(buildBundle)
        return null;
    }

    try {
        const res = await search.sendBundle(buildBundle);
        //console.log('reponse_bundle:', res);
    } catch (e) {
        console.log('error sending bundle:\n', e);
    }
    return buildBundle;
}


export const onBundleResult = (c: SearcherClient): Promise<[number, any]> => {


    return new Promise((resolve) => {

        let state = 0;
        let isResolved = false;


        const listener = c.onBundleResult(
            //@ts-ignore
            (result) => {

                if (isResolved) return state;


                const bundleId = result.bundleId;
                const isAccepted = result.accepted;
                const isRejected = result.rejected;

                if (isResolved == false) {

                    if (isAccepted) {
                        //console.log(result);

                        console.log(
                            "bundle accepted, ID:",
                            bundleId,
                            " Slot: ",
                            result?.accepted?.slot
                        );
                        state += 1;
                        isResolved = true;
                        //listener()
                        resolve([state, listener]); // Resolve with 'first' when a bundle is accepted
                    }

                    if (isRejected) {
                        if (isRejected.simulationFailure) {
                            console.log(isRejected.simulationFailure.msg ?? '');
                            console.log('\n')
                        }

                        if (isRejected.internalError) {
                            console.log('\n')
                            console.log(isRejected.internalError.msg);
                        }

                        if (isRejected.stateAuctionBidRejected) {
                            console.log('\n')
                            console.log(isRejected.stateAuctionBidRejected.msg ?? '');
                        }

                        if (isRejected.droppedBundle) {
                            console.log('\n')
                            console.log(isRejected.droppedBundle);
                        }
                        isResolved = true;
                        resolve([state, listener]);
                    }

                }

            },
            (e) => {
                console.error(e);
                // Do not reject the promise here
            }
        );


        // Set a timeout to reject the promise if no bundle is accepted within 30 seconds
        //setTimeout(() => {
        //    listener();
        //    resolve(first);
        //    isResolved = true
        //}, 30000);


    });
};


//metadata pda

export function getMetadataPda(mint: PublicKey) {
    const [metadataPda, _] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("metadata"),
            new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(),
            mint.toBuffer(),
        ],
        new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
    )
    return metadataPda
}

//master edition pda 
export function getMasterEditionPda(mint: PublicKey) {
    const [masterEditionPda, _] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("metadata"),
            new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(),
            mint.toBuffer(),
            Buffer.from("edition"),
        ],
        new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
    )
    return masterEditionPda
}

//token record pda 
export function getTokenRecord(mint: PublicKey, ata: PublicKey) {
    const [TokenRecord, _] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("metadata"),
            new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(),
            mint.toBuffer(),
            Buffer.from("token_record"),
            ata.toBuffer(),
        ],
        new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
    )
    return TokenRecord
}

//master edition pda 
export function getMetadataDelegateRecord(mint: PublicKey, ata: PublicKey, delegate: PublicKey, updateAuthority: PublicKey,) {
    const [pda, _] = PublicKey.findProgramAddressSync(
        [
            anchor.utils.bytes.utf8.encode("metadata"),
            new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(),
            mint.toBuffer(),
            anchor.utils.bytes.utf8.encode("update"),
            updateAuthority.toBuffer(),
            delegate.toBuffer(),
        ],
        new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
    )
    return pda
}


export async function getPriorityFeeEstimate(HeliusURL: string, priorityLevel: any, transaction: Transaction) {
    const response = await fetch(HeliusURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            method: "getPriorityFeeEstimate",
            params: [
                {
                    transaction: bs58.encode(transaction.serialize()), // Pass the serialized transaction in Base58
                    options: { priorityLevel: priorityLevel },
                },
            ],
        }),
    });
    const data = await response.json();
    console.log(
        "Fee in function for",
        priorityLevel,
        " :",
        data.result.priorityFeeEstimate
    );
    return data.result;
}

export async function sendTransactionWithPriorityFee(HeliusURL: string, priorityLevel: string, fromKeypair: Keypair, transaction: Transaction, connection: Connection): Promise<string | undefined> {
    let txid;

    transaction.recentBlockhash = (
        await connection.getLatestBlockhash()
    ).blockhash;
    transaction.sign(fromKeypair);

    let feeEstimate = { priorityFeeEstimate: 0 };
    if (priorityLevel !== "NONE") {
        feeEstimate = await getPriorityFeeEstimate(HeliusURL, priorityLevel, transaction);
        const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: feeEstimate.priorityFeeEstimate,
        });
        transaction.add(computePriceIx);
    }

    try {
        txid = await sendAndConfirmTransaction(connection, transaction, [
            fromKeypair,
        ]);
        console.log(`Transaction sent successfully with signature ${txid}`);

    } catch (e) {
        console.error(`Failed to send transaction: ${e}`);
    }
    return txid;
}
