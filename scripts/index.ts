import { validateSolAddress, getKeypairFromBs58, ConstructOptimalTransaction, getRandomNumber, buildBundle, onBundleResult, getCurrentDateTime, roundUpToNonZeroString, sleep } from "../utils";
import idl from "../constants/idl.json";
import { TransactionInstruction, Connection, LAMPORTS_PER_SOL, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction, PartiallyDecodedInstruction, ParsedInstruction, ParsedTransactionWithMeta, Keypair, Commitment, Finality, VersionedTransactionResponse, } from "@solana/web3.js"
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, getAccount, getAssociatedTokenAddress, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import dotenv from "dotenv";
import { parseSignatures } from "../utils";
import fs from "fs";
import axios from "axios";
export type TransactionResult = {
  signature?: string;
  error?: unknown;
  results?: VersionedTransactionResponse;
  success: boolean;
};

const PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const GLOBAL_ACCOUNT_SEED = "global";
export const MINT_AUTHORITY_SEED = "mint-authority";
export const BONDING_CURVE_SEED = "bonding-curve";
export const METADATA_SEED = "metadata";
// const program: Program<PumpFun>;

export type PriorityFee = {
  unitLimit: number;
  unitPrice: number;
};

import {
  programID,
  MEMO_PROGRAM_ID,
  feeRecipient,
  EVENT_AUTH,
} from "../constants"
import { getTokenMetadata } from "../metadata";
import { JitoTransactionExecutor } from "./jito-transaction-executor";
import bs58 from "bs58";
import { BondingCurveAccount } from "./bondingCurveAccount";
import { DEFAULT_COMMITMENT, calculateWithSlippageBuy, sendTx } from "./util";
import { GlobalAccount } from "./globalAccount";

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

interface MinPoolData {
  globalState: PublicKey,
  feeRecipient: PublicKey,
  mint: PublicKey,
  bondingCurve: PublicKey,
  bondingCurveAta: PublicKey,
  user: PublicKey,
  userAta: PublicKey,
  decimals: number,
  signerTokenAccount: PublicKey,
  account: any, virtualTokenPrice: number
}

process.removeAllListeners('warning')
dotenv.config();
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY as string;
const vitualSolToSol = 32000000000


const pumpfunApi = "https://client-api-2-74b1891ee9f9.herokuapp.com/coins?offset=0&limit=50&sort=last_trade_timestamp&searchTerm="

// export const connection = new Connection(RPC_ENDPOINT, {
//   wsEndpoint: RPC_WEBSOCKET_ENDPOINT
// })

const searchInstruction = "InitializeMint2";
const pumpProgramId = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const signerKeypair = getKeypairFromBs58(PRIVATE_KEY);
// let priorityFee: number = 1000000
let priorityFee: number = 8000000
const connection = new Connection(process.env.RPC_URL as string, { commitment: 'confirmed', });

const program = new Program(idl as anchor.Idl, programID, new anchor.AnchorProvider(connection, new NodeWallet(signerKeypair), anchor.AnchorProvider.defaultOptions()));
const maxRetriesString = process.env.MAX_RETRIES as string;
const maxRetries = Number(maxRetriesString);
const buyNumberAmount = Number(0.0008);
const buyMinMaxAmount = buyNumberAmount + (buyNumberAmount * 0.15);
const buyMaxSolCost = buyMinMaxAmount

const sellNumberAmount = Number(10000);
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
        `https://solscan.io/tx/${txId}`,
        new Date().toLocaleString()
      );
      console.log("buying...");
      await buy(txId);

      // const poolData: PoolData | undefined = await getMintPoolData(txId);
      // if (!poolData) {
      //   console.log("No pool data found");
      //   return;
      // }

      // const buyAmountSol = BigInt(1000000);
      // const slippageBasisPoints = BigInt(100);
      // const priorityFees = {
      //   unitLimit: 101337,
      //   unitPrice: 421197,
      // };
      // const result = await buyv3(
      //   signerKeypair,
      //   poolData.mint,
      //   buyAmountSol,
      //   slippageBasisPoints,
      //   priorityFees
      // );
      // console.log(result);
      // await sleep(5000);
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

async function getMintPoolDataFromMint(mintAddress: string, ownerAddress: string): Promise<MinPoolData | undefined> {
  const mint = new PublicKey(mintAddress);
  const owner = new PublicKey(ownerAddress);
  const globalState = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf")
  const response = await axios.get(pumpfunApi + mintAddress);

  const bondingCurve = response.data[0].bonding_curve;
  const bondingCurveAta = response.data[0].associated_bonding_curve;

  const userAta = getAssociatedTokenAddressSync(mint, owner, true);
  const signerTokenAccount = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID,);
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

  const poolData: MinPoolData = {
    globalState,
    feeRecipient: new PublicKey(feeRecipient),
    mint,
    bondingCurve,
    bondingCurveAta,
    user: owner,
    userAta,
    signerTokenAccount,
    decimals,
    account,
    virtualTokenPrice,
  }
  return poolData;
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

async function buildSellTx(program: Program, sellAmount: number, globalState: PublicKey, feeRecipient: PublicKey, mint: PublicKey, bondingCurve: PublicKey, bondingCurveAta: PublicKey, user: PublicKey, userAta: PublicKey): Promise<Transaction> {

  const tx = new Transaction();



  const mintDecimals = 6;
  const snipeIx = await program.methods.sell(
    //new BN(10000000000),
    new BN((sellAmount * (10 ** mintDecimals))),
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

  return finalTx;
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



async function buyV2(mint: string, buySolAmount: number, user: string) {
  const minPoolData = await getMintPoolDataFromMint(mint, user);

  const finalAmount = (buySolAmount / minPoolData!.virtualTokenPrice);
  const retries = 0;
  while (retries <= (maxRetries ? Math.max(1, maxRetries) : 5)) {
    const tx = await buildBuyTx(program, finalAmount, buyMaxSolCost, minPoolData!.globalState, new PublicKey(feeRecipient), minPoolData!.mint, minPoolData!.bondingCurve, minPoolData!.bondingCurveAta, new PublicKey(user), minPoolData!.userAta, minPoolData!.decimals, minPoolData!.signerTokenAccount, minPoolData!.account);
    console.log(`\n\nRetrying ${retries + 1} of ${maxRetries ? maxRetries : 5}...`);
    console.log(`\n\nSending Transaction...`);

    const signature = await connection.sendRawTransaction(
      tx.serialize(),
      {
        preflightCommitment: "confirmed"
      }
    )
    console.log(`Buy Transaction sent: https://solscan.io/tx/${signature}`, new Date().toLocaleString());

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
        break;
      } else {
        console.log(`Transaction failed: ${confirmation.value.err}`);
      }
    } else {

    }
  }
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
      const finalTx = await buildBuyTx(program, finalAmount, buyMaxSolCost, globalState, new PublicKey(feeRecipient), mint, bondingCurve, bondingCurveAta, user, userAta, decimals, signerTokenAccount, account);
      console.log(`\n\nRetrying ${retries + 1} of ${maxRetries ? maxRetries : 5}...`);
      console.log(`\n\nSending Transaction...`);


      const JITO_AUTH_PRIVATE_KEY = "4LgKQEP9b64X3FnWJAjNk45eJ1CCMYkJbK2Aiuc9rQLGqfy8L7u8Ar9z9YU2mWSpwfvpCymgcUe2oWUhmEVhDVSe"
      const jitoBlockEngineUrl = "amsterdam.mainnet.block-engine.jito.wtf"
      const jitoWallet = getWallet(JITO_AUTH_PRIVATE_KEY.trim());
      //const wallet = getWallet(PRIVATE_KEY.trim());
      const txExecutor = new JitoTransactionExecutor(
        connection,
        jitoBlockEngineUrl,
        jitoWallet,
        signerKeypair,
        //slotSubscriber
      );

      const latestBlockhash = await connection.getLatestBlockhash();
      const result = await txExecutor.executeAndConfirm(finalTx, signerKeypair, latestBlockhash)
      const signature = result.signature;

      // const signature = await connection.sendRawTransaction(
      //   finalTx.serialize(),
      //   {
      //     preflightCommitment: "confirmed"
      //   }
      // )
      // console.log(`Buy Transaction sent: https://solscan.io/tx/${signature}`, new Date().toLocaleString());

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
          break;
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

async function sellV2(mintAddress: string, sellTokenAmount: number, user: string) {


  const minPoolData = await getMintPoolDataFromMint(mintAddress, user);

  if (!minPoolData) {
    console.log("No pool data found");
    return;
  }


  const sellTx = await buildSellTx(program, sellTokenAmount, minPoolData.globalState, new PublicKey(feeRecipient), minPoolData.mint, minPoolData.bondingCurve, minPoolData.bondingCurveAta, new PublicKey(user), minPoolData.userAta);



  const signature = await connection.sendRawTransaction(
    sellTx.serialize(),
    {
      preflightCommitment: "confirmed"
    }
  )

  //console.log(`Transaction sent: https://solscan.io/tx/${signature}`);

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

  // const signature = await connection.sendRawTransaction(
  //   finalTx.serialize(),
  //   {
  //     preflightCommitment: "confirmed"
  //   }
  // )

  const JITO_AUTH_PRIVATE_KEY = "4LgKQEP9b64X3FnWJAjNk45eJ1CCMYkJbK2Aiuc9rQLGqfy8L7u8Ar9z9YU2mWSpwfvpCymgcUe2oWUhmEVhDVSe"
  const jitoBlockEngineUrl = "amsterdam.mainnet.block-engine.jito.wtf"
  const jitoWallet = getWallet(JITO_AUTH_PRIVATE_KEY.trim());
  const wallet = getWallet(PRIVATE_KEY.trim());
  const txExecutor = new JitoTransactionExecutor(
    connection,
    jitoBlockEngineUrl,
    jitoWallet,
    wallet,
    //slotSubscriber
  );

  const latestBlockhash = await connection.getLatestBlockhash();
  const result = await txExecutor.executeAndConfirm(finalTx, wallet, latestBlockhash)
  const signature = result.signature;

  //console.log(`Transaction sent: https://solscan.io/tx/${signature}`);

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
  await findNewTokensV2()

  //await buy("26t9WW1Tys2TthEwkE3LHgAVaMP2rv7FbsEVUpLywL7ZxfV5365AiZyFnjyJYrhkoCxCrCMLTV4eLjEmupmMNPrH")
  //await sell("4vFnPMGXcbNcktRKWcCNWVGAwRNWJjB6kEM61YeNNmyvXLWjjVBh4kRYYWJn2RNXHj3sVEpUXh9Xk26PYgjx9hFA")

  //await buyV2("DCNqAP2PFtZik4KZEV6UoARE6AB7Ym7vUL8pB7J9g4wA", buyNumberAmount, signerKeypair.publicKey.toBase58())
  //await sellV2("DCNqAP2PFtZik4KZEV6UoARE6AB7Ym7vUL8pB7J9g4wA", sellNumberAmount, signerKeypair.publicKey.toBase58())

  //const tokenMetadata = await getTokenMetadata(new PublicKey("DCNqAP2PFtZik4KZEV6UoARE6AB7Ym7vUL8pB7J9g4wA"), connection)
  //console.log(tokenMetadata)
}

export function getWallet(wallet: string): Keypair {
  // most likely someone pasted the private key in binary format
  if (wallet.startsWith('[')) {
    const raw = new Uint8Array(JSON.parse(wallet))
    return Keypair.fromSecretKey(raw);
  }

  // most likely someone pasted mnemonic
  // if (wallet.split(' ').length > 1) {
  //   const seed = mnemonicToSeedSync(wallet, '');
  //   const path = `m/44'/501'/0'/0'`; // we assume it's first path
  //   return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
  // }

  // most likely someone pasted base58 encoded private key
  return Keypair.fromSecretKey(bs58.decode(wallet));
}

function getBondingCurvePDA(mint: PublicKey) {

  return PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
    program.programId
  )[0];
}

async function getBondingCurveAccount(
  mint: PublicKey,
  commitment: Commitment = "confirmed"
) {
  const tokenAccount = await connection.getAccountInfo(
    getBondingCurvePDA(mint),
    commitment
  );
  if (!tokenAccount) {
    return null;
  }
  return BondingCurveAccount.fromBuffer(tokenAccount!.data);
}

async function getGlobalAccount(commitment: Commitment = DEFAULT_COMMITMENT) {

  const [globalAccountPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from(GLOBAL_ACCOUNT_SEED)],
    new PublicKey(PROGRAM_ID)
  );

  const tokenAccount = await connection.getAccountInfo(
    globalAccountPDA,
    commitment
  );

  return GlobalAccount.fromBuffer(tokenAccount!.data);
}

async function getBuyInstructions(
  buyer: PublicKey,
  mint: PublicKey,
  feeRecipient: PublicKey,
  amount: bigint,
  solAmount: bigint,
  commitment: Commitment = DEFAULT_COMMITMENT
) {
  const associatedBondingCurve = await getAssociatedTokenAddress(
    mint,
    getBondingCurvePDA(mint),
    true
  );

  const associatedUser = await getAssociatedTokenAddress(mint, buyer, false);

  let transaction = new Transaction();

  try {
    await getAccount(connection, associatedUser, commitment);
  } catch (e) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        buyer,
        associatedUser,
        buyer,
        mint
      )
    );
  }

  transaction.add(
    await program.methods
      .buy(new BN(amount.toString()), new BN(solAmount.toString()))
      .accounts({
        feeRecipient: feeRecipient,
        mint: mint,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: associatedUser,
        user: buyer,
      })
      .transaction()
  );

  return transaction;
}

async function getBuyInstructionsBySolAmount(
  buyer: PublicKey,
  mint: PublicKey,
  buyAmountSol: bigint,
  slippageBasisPoints: bigint = 500n,
  commitment: Commitment = "confirmed"
) {
  let bondingCurveAccount = await getBondingCurveAccount(
    mint,
    commitment
  );
  if (!bondingCurveAccount) {
    throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
  }

  let buyAmount = bondingCurveAccount.getBuyPrice(buyAmountSol);
  let buyAmountWithSlippage = calculateWithSlippageBuy(
    buyAmountSol,
    slippageBasisPoints
  );

  let globalAccount = await getGlobalAccount(commitment);

  return await getBuyInstructions(
    buyer,
    mint,
    globalAccount.feeRecipient,
    buyAmount,
    buyAmountWithSlippage
  );
}


async function buyv3(
  buyer: Keypair,
  mint: PublicKey,
  buyAmountSol: bigint,
  slippageBasisPoints: bigint = 500n,
  priorityFees?: PriorityFee,
  commitment: Commitment = "confirmed",
  finality: Finality = "confirmed"
): Promise<TransactionResult> {
  let buyTx = await getBuyInstructionsBySolAmount(
    buyer.publicKey,
    mint,
    buyAmountSol,
    slippageBasisPoints,
    commitment
  );

  let buyResults = await sendTx(
    connection,
    buyTx,
    buyer.publicKey,
    [buyer],
    priorityFees,
    commitment,
    finality
  );
  return buyResults;
}

main().catch(console.error);