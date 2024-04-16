import {
  Metaplex,
  Nft,
  NftWithToken,
  Sft,
  SftWithToken
} from '@metaplex-foundation/js'
import { Connection, PublicKey } from '@solana/web3.js'

export async function getTokenMetadata(
  mint: PublicKey,
  connection: Connection
) {
  // let token: Sft | SftWithToken | Nft | NftWithToken

  const metaplex = Metaplex.make(connection)
  const metadataAccount = metaplex.nfts().pdas().metadata({ mint: mint })

  const metadataAccountInfo = await connection.getAccountInfo(metadataAccount)

  if (metadataAccountInfo) {
    return await metaplex.nfts().findByMint({ mintAddress: mint })
  }
  return undefined
}
