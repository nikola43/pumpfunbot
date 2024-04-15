import { validateSolAddress, getKeypairFromBs58, ConstructOptimalTransaction, getRandomNumber, buildBundle, onBundleResult, getCurrentDateTime, roundUpToNonZeroString } from "../utils";
import idl from "../constants/idl.json";
import { TransactionInstruction, Connection, LAMPORTS_PER_SOL, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction, PartiallyDecodedInstruction, ParsedInstruction, ParsedTransactionWithMeta, } from "@solana/web3.js"
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import dotenv from "dotenv";
import { parseSignatures } from "../utils";
import { sleep, getUserInput } from "../utils";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";

import {
    programID,
    MEMO_PROGRAM_ID,
    feeRecipient,
    EVENT_AUTH,
} from "../constants"


process.removeAllListeners('warning')
dotenv.config();


async function main() {

    try {

        const pk = process.env.SIGNER_PRIVATE_KEY as string;
        if (!pk || pk == '<YOUR SIGNER KEYPAIR HERE>') {
            console.log('missing signer keypair');
            console.log('please fill it in .env file');
            return
        }

        const url = process.env.RPC_URL as string;
        if (!url || url == '<YOUR RPC URL HERE>') {
            console.log('missing rpc endpoint');
            console.log('please fill it in .env file');
            return
        }

        const jitoAuthPrivateKey = process.env.JITO_AUTH_PRIVATE_KEY as string;
        if (!jitoAuthPrivateKey || jitoAuthPrivateKey == '<YOUR AUTH KEYPAIR HERE>') {
            console.log('Missing jito authentication private key');
            console.log('please fill it in the .env file.');
            return
        }

        const blockEngineUrl = process.env.BLOCK_ENGINE_URL as string;
        if (!blockEngineUrl) {
            console.log('Missing block engine url');
            console.log('please fill it in the .env file.');
            return
        }

        const envTip = process.env.JITO_TIP as string;
        const jitoTip = Number(envTip);
        if (!jitoTip) {
            console.log('invalid jito tip');
            console.log('please fix it in the .env file.');
            return
        }

        const maxRetriesString = process.env.MAX_RETRIES as string;
        const maxRetries = Number(maxRetriesString);




        const connection = new Connection(process.env.RPC_URL as string, { commitment: 'confirmed', });
        const signerKeypair = getKeypairFromBs58(pk);

        //getting the  wallet to track:
        const inputtedWallet = (await getUserInput("Enter the wallet address to monitor: "));
        if (!validateSolAddress(inputtedWallet)) {
            console.log('invalid wallet address');
            return;
        }

        //getting the amount to swap with:
        const inputtedAmount = (await getUserInput("Enter the amount of SOL to snipe with: "));
        const numberAmount = Number(inputtedAmount);
        if (!numberAmount) {
            console.log('invalid sol amount');
            return;
        }

        const minMaxAmount = numberAmount + (numberAmount * 0.15);

        //getting max amount to swap with:
        const inputtedMaxSolCost = (await getUserInput(`Enter the maximum amount of SOL accounting to slippage (min ${roundUpToNonZeroString(parseFloat((minMaxAmount).toFixed(6)))} SOL): `));
        const maxSolCost = Number(inputtedMaxSolCost);
        if (!maxSolCost || maxSolCost < minMaxAmount) {
            console.log('invalid maximum sol amount');
            return;
        }

        //getting the micro lamports for compute budget price:
        let priorityFee: number = -1;
        const inputtedPriorityFee = (await getUserInput("Enter Priority-fee in micro-lamports ('default' for default fee <1,000,000>): "));
        if (inputtedPriorityFee.toUpperCase() != 'DEFAULT') {
            priorityFee = Number(inputtedPriorityFee);
            if (!priorityFee || priorityFee < 0) {
                console.log('invalid priority fee input');
                return
            }
        }

        console.log('\n');
        console.log(`Scanning wallet ${inputtedWallet}\n`)

        //caching to avoid accidental duplicate on-chain reads 
        //var cache: Set<string> = new Set();
        //
        //setInterval(() => {
        //    cache.clear();
        //    console.log("cache flushed");
        //}, 3 * 60 * 1000);



        //start monitoring

        let neededInstruction: PartiallyDecodedInstruction | ParsedInstruction | null = null;
        let parsedSig: ParsedTransactionWithMeta | null = null

        while (neededInstruction == null) {
            const data = await connection.getConfirmedSignaturesForAddress2(new PublicKey(inputtedWallet), { limit: 10, },);
            const confirmed_sigs: string[] = data.filter(e => !e.err).map(e => e.signature);

            if (confirmed_sigs.length === 0) {
                await sleep(500);
                console.log('No signatures found, polling for new signatures..')
                continue
            }
            //console.log(confirmed_sigs);

            const parsed_sigs = await parseSignatures(connection, confirmed_sigs);


            for (var i = 0; i < parsed_sigs.length; i++) {
                try {
                    const sig = parsed_sigs[i];
                    if (!sig) { continue }

                    const blockTime = sig.blockTime;
                    const currentTime = Math.floor(Date.now() / 1000);

                    //@ts-ignore
                    const instructions = (sig.transaction.message.instructions);
                    for (let ix of instructions) {
                        try {
                            const hasNeededProgramId = (ix.programId.toBase58() == programID);
                            //@ts-ignore
                            //console.log(ix.accounts.length);
                            //console.log(ix.programId.toBase58());
                            //console.log(confirmed_sigs[i])


                            //@ts-ignore
                            const hasNeededAccounts = ix.accounts.length == 14;

                            if (hasNeededProgramId && hasNeededAccounts) {
                                //transaction should should be processed within one minute of detecting it here
                                if (!blockTime || currentTime - blockTime > 60) {
                                    console.log(`${getCurrentDateTime()} Old Bonding Curve detected, Ignoring stale pool...`)
                                } else {
                                    neededInstruction = ix;
                                    parsedSig = sig
                                    break
                                }
                            }
                        } catch (e) {
                            continue
                        }
                    }
                    if (neededInstruction) { break };

                } catch (e) {
                    continue
                }
                if (neededInstruction) { break };
            }

            if (neededInstruction) { break };

            console.log(`${getCurrentDateTime()} No bonding curves found. Polling for new signatures...\n`);
            await sleep(500);

        }


        if (!neededInstruction) { return }

        console.log(`\nFound new pool/bonding-curve, Sniping with ${numberAmount} SOL..\n\n`);

        //initializing program
        const program = new Program(idl as anchor.Idl, programID, new anchor.AnchorProvider(connection, new NodeWallet(signerKeypair), anchor.AnchorProvider.defaultOptions()));


        //@ts-ignore

        //getting needed accounts
        const accounts = neededInstruction.accounts
        const mint = accounts[0];
        const mintAuth = accounts[1];
        const bondingCurve = accounts[2];
        const bondingCurveAta = accounts[3];
        const globalState = accounts[4];
        const user = signerKeypair.publicKey;
        const userAta = getAssociatedTokenAddressSync(mint, user, true);
        const signerTokenAccount = getAssociatedTokenAddressSync(mint, user, true, TOKEN_PROGRAM_ID,);


        const [bondingCurveData, mintData, account] = await Promise.all([
            program.account.bondingCurve.fetch(bondingCurve),
            connection.getParsedAccountInfo(mint),
            connection.getAccountInfo(signerTokenAccount, 'processed')
        ]);


        //@ts-ignore
        const decimals = mintData.value?.data.parsed.info.decimals;
        const virtualTokenReserves = (bondingCurveData.virtualTokenReserves as any).toNumber();
        const virtualSolReserves = (bondingCurveData.virtualSolReserves as any).toNumber();

        const adjustedVirtualTokenReserves = virtualTokenReserves / (10 ** decimals);
        const adjustedVirtualSolReserves = virtualSolReserves / LAMPORTS_PER_SOL;


        const virtualTokenPrice = adjustedVirtualSolReserves / adjustedVirtualTokenReserves;
        const finalAmount = (numberAmount / virtualTokenPrice);


        //console.log(adjustedVirtualSolReserves);
        //console.log(adjustedVirtualTokenReserves);
        //
        //console.log(finalAmount);
        //console.log(virtualTokenPrice);
        //console.log(virtualTokenReserves);
        //console.log(virtualSolReserves);
        //console.log(decimals);
        //console.log(mint);
        //console.log(bondingCurve);
        //console.log(finalAmount);



        let retries = 0;
        while (retries <= (maxRetries ? Math.max(1, maxRetries) : 5)) {

            //creating tx;
            const tx = new Transaction();

            if (!account) {
                tx.add(
                    createAssociatedTokenAccountInstruction(
                        user,
                        signerTokenAccount,
                        user,
                        mint,
                    )
                )
            };

            const snipeIx = await program.methods.buy(
                new BN((finalAmount * (10 ** decimals))),
                new BN(maxSolCost * LAMPORTS_PER_SOL),
            ).accounts({
                global: globalState,
                feeRecipient: feeRecipient,
                mint: mint,
                bondingCurve: bondingCurve,
                associatedBondingCurve: bondingCurveAta,
                associatedUser: userAta,
                user: user,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
                eventAuthority: EVENT_AUTH,
                program: program.programId,
            }).instruction();
            tx.add(snipeIx);


            const memoix = new TransactionInstruction({
                programId: new PublicKey(MEMO_PROGRAM_ID),
                keys: [],
                data: Buffer.from(getRandomNumber().toString(), "utf8")
            })
            tx.add(memoix);

            //preparing transaction
            const hashAndCtx = await connection.getLatestBlockhashAndContext('processed');
            const recentBlockhash = hashAndCtx.value.blockhash;
            const lastValidBlockHeight = hashAndCtx.value.lastValidBlockHeight;

            tx.recentBlockhash = recentBlockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            tx.feePayer = user;

            const finalTx = await ConstructOptimalTransaction(tx, connection, priorityFee);

            finalTx.sign(signerKeypair);

            const jitoAuthKeypair = getKeypairFromBs58(jitoAuthPrivateKey);


            const bundleTransactionLimit = 1;
            const search = searcherClient(blockEngineUrl, jitoAuthKeypair);

            const bundleCtx = await buildBundle(
                search,
                bundleTransactionLimit,
                finalTx,
                signerKeypair,
                jitoTip,
            );

            if (bundleCtx != null) {
                const bundleResult = await onBundleResult(search);
                if (bundleResult[0]) {
                    console.log('Successful! ');
                    process.exit(0);
                } else {
                    console.log('Failed to send Bundle, retrying... (ctrl + c to abort)');
                    console.log('Retries left: ', maxRetries - retries);
                    bundleResult[1]()
                    retries += 1;
                    continue
                }
            } else {
                throw new Error
            }
        }

        console.log('\nMax Retries Reached.');
        process.exit(1);

    } catch (e) {
        console.log(e);
        console.log('an error has occurred');
    }
}

main()