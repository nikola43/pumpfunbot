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
const PRIVATE_KEY = "5QgozLz3sqx3Dcdj6rwKuCr6LJjq6J7FYaUgwjY2LduHjtNifMiQ5KwoCKVsAU9jkD94SPJEo1dMADoMY4roWDvM"


const RPC_ENDPOINT = "https://solana-mainnet.core.chainstack.com/444a9722c51931fbf1f90e396ce78229"
const RPC_WEBSOCKET_ENDPOINT = "wss://api.mainnet-beta.solana.com"

export const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT
})

const searchInstruction = "InitializeMint2";
const pumpProgramId = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const signerKeypair = getKeypairFromBs58(PRIVATE_KEY);
const priorityFee: number = 2000000


async function startConnection(
  programAddress: PublicKey,
  searchInstruction: string,
  callBackFunction: Function
): Promise<void> {
  console.log("Monitoring logs for program:", programAddress.toString());
  connection.onLogs(
    programAddress,
    ({ logs, err, signature }) => {
      if (err) return;
      // console.log("Logs found:", logs);
      // if (logs && logs.some((log) => log.includes(searchInstruction))) {
      if (logs) {
        callBackFunction(signature);
      }
    },
    "finalized"
  );
}

async function fetchPumpPairs(txId: string) {
  try {
    const tx = await connection.getParsedTransaction(txId, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    //@ts-ignore
    const accounts = (tx?.transaction.message.instructions).find(
      (ix) =>
        ix.programId.toBase58() === pumpProgramId.toBase58()
      // @ts-ignore
    ).accounts as PublicKey[];

    if (!accounts) {
      console.log("No accounts found in the transaction.");
      return;
    }


    if (accounts.length === 14) {
      console.log("Accounts found:", accounts.length);

      console.log(
        `Signature for ${searchInstruction}:`,
        `https://solscan.io/tx/${txId}`
      );

      await buy(txId);

    }


  } catch (error) {
    // console.error(error);
  }
}

async function findNewTokensV2() {
  startConnection(
    pumpProgramId,
    searchInstruction,
    fetchPumpPairs
  ).catch(console.error);
}



async function buy(txId: string) {

  try {



    const maxRetriesString = process.env.MAX_RETRIES as string;
    const maxRetries = Number(maxRetriesString);
    const connection = new Connection(process.env.RPC_URL as string, { commitment: 'confirmed', });



    //getting the amount to swap with:

    const numberAmount = Number(0.0001);
    const minMaxAmount = numberAmount + (numberAmount * 0.15);

    //getting max amount to swap with:
    const maxSolCost = minMaxAmount


    //getting the micro lamports for compute budget price:

    //start monitoring

    let neededInstruction: PartiallyDecodedInstruction | ParsedInstruction | null = null;
    let parsedSig: ParsedTransactionWithMeta | null = null


    //const data = await connection.getConfirmedSignaturesForAddress2(new PublicKey(inputtedWallet), { limit: 10, },);
    const confirmed_sigs: string[] = [txId]


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

            if (!ix.accounts) {
              continue
            }

            //@ts-ignore
            const hasNeededAccounts = ix.accounts.length == 14;

            if (hasNeededProgramId && hasNeededAccounts) {
              // transaction should should be processed within one minute of detecting it here
              // if (!blockTime || currentTime - blockTime > 60) {
              //   console.log(`${getCurrentDateTime()} Old Bonding Curve detected, Ignoring stale pool...`)
              // } else {
              //   neededInstruction = ix;
              //   parsedSig = sig
              // }

              neededInstruction = ix;
              parsedSig = sig




            }
          } catch (e) {
            console.log(e);
          }
        }


      } catch (e) {
        console.log(e);
      }

    }



    console.log(`${getCurrentDateTime()} No bonding curves found. Polling for new signatures...\n`);
    await sleep(500);




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
      // const hashAndCtx = await connection.getLatestBlockhashAndContext('processed');
      const hashAndCtx = await connection.getLatestBlockhashAndContext('confirmed');
      const recentBlockhash = hashAndCtx.value.blockhash;
      const lastValidBlockHeight = hashAndCtx.value.lastValidBlockHeight;

      tx.recentBlockhash = recentBlockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = user;

      const finalTx = await ConstructOptimalTransaction(tx, connection, priorityFee);

      finalTx.sign(signerKeypair);

      const signature = await connection.sendRawTransaction(
        finalTx.serialize(),
        {
          preflightCommitment: "confirmed"
        }
      )

      if (signature && signature.length > 0) {
        const latestBlockhash = await connection.getLatestBlockhash({
          commitment: "confirmed"
        })
        const confirmation = await connection.confirmTransaction(
          {
            signature,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            blockhash: latestBlockhash.blockhash
          },
          "confirmed"
        )
        if (!confirmation.value.err) {
          console.log(`Transaction confirmed: https://solscan.io/tx/${signature}`);
        } else {
          console.log(`Transaction failed: ${confirmation.value.err}`);
        }
      } else {

      }



      // console.log(`Transaction sent: https://solscan.io/tx/${signature}`);
    }

    console.log('\nMax Retries Reached.');
    process.exit(1);

  } catch (e) {
    console.log(e);
    console.log('an error has occurred');
  }
}

async function sell(mintAddress: string, amount: number) {
  const program = new Program(idl as anchor.Idl, programID, new anchor.AnchorProvider(connection, new NodeWallet(signerKeypair), anchor.AnchorProvider.defaultOptions()));

  const mint = new PublicKey(mintAddress);
  const user = signerKeypair.publicKey;
  const userAta = getAssociatedTokenAddressSync(mint, user, true);
  const signerTokenAccount = getAssociatedTokenAddressSync(mint, user, true, TOKEN_PROGRAM_ID,);
  const bondingCurve = ""
  const bondingCurveAta = ""
  const globalState = ""
  // const globalState = accounts[4];
  // const bondingCurveAta = accounts[3];
  // const bondingCurve = accounts[2];

  const [bondingCurveData, mintData, account] = await Promise.all([
    program.account.bondingCurve.fetch(bondingCurve),
    connection.getParsedAccountInfo(mint),
    connection.getAccountInfo(signerTokenAccount, 'processed')
  ]);

  const tx = new Transaction();



  const snipeIx = await program.methods.buy(
    new BN((100 * (10 ** 9))),
    new BN(10 * LAMPORTS_PER_SOL),
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

  const hashAndCtx = await connection.getLatestBlockhashAndContext('confirmed');
  const recentBlockhash = hashAndCtx.value.blockhash;
  const lastValidBlockHeight = hashAndCtx.value.lastValidBlockHeight;

  tx.recentBlockhash = recentBlockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;

  const finalTx = await ConstructOptimalTransaction(tx, connection, priorityFee);

  finalTx.sign(signerKeypair);

  const signature = await connection.sendRawTransaction(
    finalTx.serialize(),
    {
      preflightCommitment: "confirmed"
    }
  )

  console.log(`Transaction sent: https://solscan.io/tx/${signature}`);

  if (signature && signature.length > 0) {
    const latestBlockhash = await connection.getLatestBlockhash({
      commitment: "confirmed"
    })
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash
      },
      "confirmed"
    )
    if (!confirmation.value.err) {
      console.log(`Transaction confirmed: https://solscan.io/tx/${signature}`);
    } else {
      console.log(`Transaction failed: ${confirmation.value.err}`);
    }
  } else {

  }


}


async function main() {
  // await findNewTokensV2()

  await buy("fpBFT1T34oTB3v2NPrfkAvxnZ8X7brcz2orfBPkq5PaxWPaysKbrCGH34pD8BgnqwJuPgjj5dD4MSMyzLrvB9UC")
}

main().catch(console.error);