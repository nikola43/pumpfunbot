import { validateSolAddress, getKeypairFromBs58, ConstructOptimalTransaction, getRandomNumber, buildBundle, onBundleResult, getCurrentDateTime, roundUpToNonZeroString, listenProgramLogs, getMintPoolData, sendTx } from "../utils";
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
import fs from "fs";

import {
  programID,
  MEMO_PROGRAM_ID,
  feeRecipient,
  EVENT_AUTH,
} from "../constants"
import { PoolData } from "../types";
import { send } from "process";



process.removeAllListeners('warning')
dotenv.config();
const PRIVATE_KEY = "5QgozLz3sqx3Dcdj6rwKuCr6LJjq6J7FYaUgwjY2LduHjtNifMiQ5KwoCKVsAU9jkD94SPJEo1dMADoMY4roWDvM"
const vitualSolToSol = 32000000000

const RPC_ENDPOINT = "https://solana-mainnet.core.chainstack.com/444a9722c51931fbf1f90e396ce78229"
const RPC_WEBSOCKET_ENDPOINT = "wss://api.mainnet-beta.solana.com"

// export const connection = new Connection(RPC_ENDPOINT, {
//   wsEndpoint: RPC_WEBSOCKET_ENDPOINT
// })

const searchInstruction = "InitializeMint2";
const pumpProgramId = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const signerKeypair = getKeypairFromBs58(PRIVATE_KEY);
// let priorityFee: number = 1000000
let priorityFee: number = 5000000
const connection = new Connection(process.env.RPC_URL as string, { commitment: 'confirmed', });

const program = new Program(idl as anchor.Idl, programID, new anchor.AnchorProvider(connection, new NodeWallet(signerKeypair), anchor.AnchorProvider.defaultOptions()));
const maxRetriesString = process.env.MAX_RETRIES as string;
const maxRetries = Number(maxRetriesString);
const buyNumberAmount = Number(0.0008);
const buyMinMaxAmount = buyNumberAmount + (buyNumberAmount * 0.15);
const buyMaxSolCost = buyMinMaxAmount

const sellNumberAmount = Number(10000);
const sellMinMaxAmount = sellNumberAmount + (sellNumberAmount * 0.15);

const detectedSignatures = new Set<string>();

// const numberAmount = Number(0.0001);
// const minMaxAmount = numberAmount + (numberAmount * 0.15);

//getting max amount to swap with:






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

    if (accounts.length === 14 && !detectedSignatures.has(txId)) {
      // console.log("Accounts found:", accounts.length);
      detectedSignatures.add(txId);
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

async function listenNewPairs(connection: Connection) {
  listenProgramLogs(
    connection,
    pumpProgramId,
    searchInstruction,
    fetchPumpPairs
  ).catch(console.error);
}



async function buildBuyTx(program: Program, buyNumberAmount: number, maxSolCost: number, feeRecipient: PublicKey, poolData: PoolData, priorityFee: number): Promise<Transaction> {
  const {
    account,
    mint,
    bondingCurve,
    bondingCurveAta,
    globalState,
    user,
    userAta,
    signerTokenAccount,
    decimals,
    virtualTokenPrice
  } = poolData;

  const buyAmount = (buyNumberAmount / virtualTokenPrice);

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
    new BN((buyAmount * (10 ** decimals))),
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

  return finalTx;
}



async function buy(txId: string) {

  try {
    const poolData: PoolData | undefined = await getMintPoolData(connection, program, signerKeypair.publicKey, txId);
    if (!poolData) {
      console.log("No pool data found");
      return;
    }

    fs.writeFileSync(`data/${poolData.mint.toBase58()}.json`, JSON.stringify(poolData, null, 2));

    let retries = 0;
    while (retries <= (maxRetries ? Math.max(1, maxRetries) : 5)) {
      const tx = await buildBuyTx(program, buyNumberAmount, buyMaxSolCost, new PublicKey(feeRecipient), poolData, priorityFee);
      console.log(`\n\nRetrying ${retries + 1} of ${maxRetries ? maxRetries : 5}...`);
      console.log(`\n\nSending Transaction...`);

      const signature = await sendTx(connection, tx);
      if (signature) {
        console.log(`Transaction sent: https://solscan.io/tx/${signature}`);
        break;
      }
      retries++;
    }

    console.log('\nMax Retries Reached.');
    process.exit(1);

  } catch (e) {
    console.log(e);
    console.log('an error has occurred');
  }
}

async function sell(txId: string) {

  // const poolDataString = fs.readFileSync("data/poolData.json", "utf8");
  // const poolData: PoolData = JSON.parse(poolDataString);
  // const { globalState, mint, bondingCurve, bondingCurveAta, userAta, user } = poolData;

  // console.log({
  //   poolData
  // })

  const poolData: PoolData | undefined = await getMintPoolData(connection, program, signerKeypair.publicKey, txId);
  if (!poolData) {
    console.log("No pool data found");
    return;
  }

  const {
    account,
    mint,
    bondingCurve,
    bondingCurveAta,
    globalState,
    user,
    userAta,
    signerTokenAccount,
    decimals,
    virtualTokenPrice } = poolData;

  const tx = new Transaction();



  const mintDecimals = 6;
  const snipeIx = await program.methods.sell(
    //new BN(10000000000),
    new BN((sellNumberAmount * (10 ** mintDecimals))),
    new BN(1),
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
  // await listenNewPairs(connection)

  await buy("3LFtxNbGippSZVKULqZ9hk6oWHqPz9r4JtP8Fg29QrcTnNt9xBQR8Ry2rqpdZi4h45mJetm7gupc4wZuwBQDh2P")
  // await sell("52v5G9z2kxLxdymHrXhq1DYcyTkDcztggJveCxxxKCLL7LnTGxLwQVmWWbmKzm4xAug33LwBL3iw8HL1TrYgYxiW")
  // const txId = "52v5G9z2kxLxdymHrXhq1DYcyTkDcztggJveCxxxKCLL7LnTGxLwQVmWWbmKzm4xAug33LwBL3iw8HL1TrYgYxiW"
  // await sell(txId)


  // const poolData: PoolData | undefined = await getMintPoolData(txId);
  // if (!poolData) {
  //   console.log("No pool data found");
  //   return;
  // }

  // const { virtualTokenPrice } = poolData;
  // console.log(virtualTokenPrice);
}

main().catch(console.error);