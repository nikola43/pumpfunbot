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
import fs from "fs";

import {
  programID,
  MEMO_PROGRAM_ID,
  feeRecipient,
  EVENT_AUTH,
} from "../constants"

interface PoolData {
  account: any,
  mint: any,
  mintAuth: any,
  bondingCurve: any,
  bondingCurveAta: any,
  globalState: any,
  user: any,
  userAta: any,
  signerTokenAccount: any,
  decimals: any,
  virtualTokenReserves: any,
  virtualSolReserves: any,
  adjustedVirtualTokenReserves: any,
  adjustedVirtualSolReserves: any,
  virtualTokenPrice: any,
}

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
let priorityFee: number = 2000000
const connection = new Connection(process.env.RPC_URL as string, { commitment: 'confirmed', });

const program = new Program(idl as anchor.Idl, programID, new anchor.AnchorProvider(connection, new NodeWallet(signerKeypair), anchor.AnchorProvider.defaultOptions()));
const maxRetriesString = process.env.MAX_RETRIES as string;
const maxRetries = Number(maxRetriesString);
const buyNumberAmount = Number(0.0008);
const buyMinMaxAmount = buyNumberAmount + (buyNumberAmount * 0.15);
const buyMaxSolCost = buyMinMaxAmount

const sellNumberAmount = Number(1000);
const sellMinMaxAmount = sellNumberAmount + (sellNumberAmount * 0.15);
const sellMaxSolCost = sellMinMaxAmount

const detectedSignatures = new Set<string>();

// const numberAmount = Number(0.0001);
// const minMaxAmount = numberAmount + (numberAmount * 0.15);

//getting max amount to swap with:




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


    if (accounts.length === 14 && !detectedSignatures.has(txId)) {
      console.log("Accounts found:", accounts.length);

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

async function findNewTokensV2() {
  startConnection(
    pumpProgramId,
    searchInstruction,
    fetchPumpPairs
  ).catch(console.error);
}


async function getMintPoolData(txId: string): Promise<PoolData | undefined> {
  let neededInstruction: PartiallyDecodedInstruction | ParsedInstruction | null = null;
  let parsedSig: ParsedTransactionWithMeta | null = null
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

      if (!neededInstruction) { continue }
      //@ts-ignore
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

      const poolData: PoolData = {
        account,
        mint,
        mintAuth,
        bondingCurve,
        bondingCurveAta,
        globalState,
        user,
        userAta,
        signerTokenAccount,
        decimals,
        virtualTokenReserves,
        virtualSolReserves,
        adjustedVirtualTokenReserves,
        adjustedVirtualSolReserves,
        virtualTokenPrice,
      }

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

      return poolData;


    } catch (e) {
      console.log(e);
    }
  }
  return undefined
}


async function buildBuyTx(program: Program, finalAmount: number, maxSolCost: number, globalState: PublicKey, feeRecipient: PublicKey, mint: PublicKey, bondingCurve: PublicKey, bondingCurveAta: PublicKey, user: PublicKey, userAta: PublicKey, decimals: number, signerTokenAccount: PublicKey, account: any): Promise<Transaction> {
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

  return finalTx;
}

async function sendTx(tx: Transaction) {

}

async function buy(txId: string) {

  try {
    const poolData: PoolData | undefined = await getMintPoolData(txId);
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
      virtualSolReserves,
      adjustedVirtualTokenReserves,
      adjustedVirtualSolReserves,
      decimals,
      virtualTokenPrice } = poolData;
    const finalAmount = (buyNumberAmount / virtualTokenPrice);

    console.log(`Virtual Sol Reserves: ${virtualSolReserves}`);
    console.log(`Virtual Token Price: ${virtualTokenPrice}`);
    console.log(`Adjusted Virtual Sol Reserves: ${adjustedVirtualSolReserves}`);
    console.log(`Adjusted Virtual Token Reserves: ${adjustedVirtualTokenReserves}`);

    console.log(`Mint: ${mint}`);

    fs.writeFileSync("poolData.json", JSON.stringify(poolData, null, 2));



    let retries = 0;
    while (retries <= (maxRetries ? Math.max(1, maxRetries) : 5)) {
      const tx = await buildBuyTx(program, finalAmount, buyMaxSolCost, globalState, new PublicKey(feeRecipient), mint, bondingCurve, bondingCurveAta, user, userAta, decimals, signerTokenAccount, account);
      console.log(`\n\nRetrying ${retries + 1} of ${maxRetries ? maxRetries : 5}...`);
      console.log(`\n\nSending Transaction...`);

      const signature = await connection.sendRawTransaction(
        tx.serialize(),
        {
          preflightCommitment: "confirmed"
        }
      )
      console.log("tx", signature)

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

async function sell(txId: string) {

  // const poolDataString = fs.readFileSync("data/poolData.json", "utf8");
  // const poolData: PoolData = JSON.parse(poolDataString);
  // const { globalState, mint, bondingCurve, bondingCurveAta, userAta, user } = poolData;

  // console.log({
  //   poolData
  // })

  const poolData: PoolData | undefined = await getMintPoolData(txId);
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
  const finalAmount = (sellNumberAmount / virtualTokenPrice);

  const snipeIx = await program.methods.sell(
    new BN((finalAmount * (10 ** decimals))),
    new BN(sellMaxSolCost * LAMPORTS_PER_SOL),
  ).accounts({
    global: new PublicKey(globalState),
    feeRecipient: feeRecipient,
    mint: new PublicKey(mint),
    bondingCurve: new PublicKey(bondingCurve),
    associatedBondingCurve: new PublicKey(bondingCurveAta),
    associatedUser: new PublicKey(userAta),
    user: new PublicKey(user),
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
  // await findNewTokensV2()

  await buy("26t9WW1Tys2TthEwkE3LHgAVaMP2rv7FbsEVUpLywL7ZxfV5365AiZyFnjyJYrhkoCxCrCMLTV4eLjEmupmMNPrH")
  //await sell("fpBFT1T34oTB3v2NPrfkAvxnZ8X7brcz2orfBPkq5PaxWPaysKbrCGH34pD8BgnqwJuPgjj5dD4MSMyzLrvB9UC")
}

main().catch(console.error);