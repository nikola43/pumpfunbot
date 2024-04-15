import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export interface PoolData {
    account: anchor.web3.AccountInfo<Buffer> | null,
    mint: PublicKey,
    mintAuth: PublicKey,
    bondingCurve: PublicKey,
    bondingCurveAta: PublicKey,
    globalState: PublicKey,
    user: PublicKey,
    userAta: PublicKey,
    signerTokenAccount: PublicKey,
    decimals: number,
    virtualTokenReserves: number,
    virtualSolReserves: number,
    realTokenReserves: number,
    realSolReserves: number,
    adjustedVirtualTokenReserves: number,
    adjustedVirtualSolReserves: number,
    virtualTokenPrice: number,
}