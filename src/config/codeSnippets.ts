export interface CodeSnippet {
  id: string;
  title: string;
  tooltip?: string;
  code: string;
}

export const dashboardSnippets: CodeSnippet[] = [
  {
    id: 'connectWallet',
    title: 'Connect Wallet',
    tooltip: 'Step 1: Connect your wallet via MetaMask',
    code: `// src/services/clientService.ts

export async function connectWallet(): Promise<\`0x\${string}\`> {
  const provider = getEthereumProvider();

  // Opens the wallet popup (e.g., MetaMask) asking the user to connect
  const accounts = await provider.request({
    method: 'eth_requestAccounts',
  });

  // Ensure the wallet is on the DataHaven testnet
  await switchToCorrectNetwork(provider);

  connectedAddress = accounts[0] as \`0x\${string}\`;

  // Create a viem WalletClient for signing transactions
  walletClientInstance = createWalletClient({
    chain,
    account: connectedAddress,
    transport: custom(provider),
  });

  // Initialize the StorageHub SDK for on-chain storage operations
  storageHubClientInstance = new StorageHubClient({
    rpcUrl: NETWORK.rpcUrl,
    chain,
    walletClient: walletClientInstance,
  });

  // Initialize the Polkadot API for substrate chain queries
  await initPolkadotApi();

  return connectedAddress;
}`,
  },
  {
    id: 'connectToMsp',
    title: 'Connect to MSP',
    tooltip: 'Step 2: Connect to the storage provider',
    code: `// src/services/mspService.ts

// Returns auth credentials for each request, or undefined if not logged in
const sessionProvider = async () => {
  const address = getConnectedAddress();
  return sessionToken && address
    ? { token: sessionToken, user: { address } }
    : undefined;
};

export async function connectToMsp(): Promise<MspClient> {
  // Return cached instance if already connected
  if (mspClientInstance) {
    return mspClientInstance;
  }

  const httpCfg: HttpClientConfig = {
    baseUrl: NETWORK.mspUrl,
  };

  // Connect to MSP — sessionProvider attaches auth to each request
  mspClientInstance = await MspClient.connect(
    httpCfg,
    sessionProvider
  );

  return mspClientInstance;
}`,
  },
  {
    id: 'authenticateUser',
    title: 'Authenticate (SIWE)',
    tooltip: 'Step 3: Sign in with Ethereum (SIWE)',
    code: `// src/services/mspService.ts

export async function authenticateUser(): Promise<UserInfo> {
  const client = getMspClient();
  const walletClient = getWalletClient();

  // SIWE requires the current domain and URI for the signed message
  const domain = window.location.hostname;
  const uri = window.location.origin;

  // Sign-In With Ethereum: MSP sends challenge → user signs → MSP verifies
  const siweSession = await client.auth.SIWE(
    walletClient,
    domain,
    uri
  );

  sessionToken = siweSession.token;

  const profile = await client.auth.getProfile();
  authenticatedUserProfile = profile;

  // Persist to sessionStorage (survives refresh, cleared on tab close)
  sessionStorage.setItem(SESSION_TOKEN_KEY, sessionToken);
  sessionStorage.setItem(
    USER_PROFILE_KEY,
    JSON.stringify(profile)
  );

  return profile;
}`,
  },
];

export const mintSnippets: CodeSnippet[] = [
  {
    id: 'ensureBucket',
    title: 'Ensure Bucket',
    tooltip: "Creates your NFT storage bucket if it doesn't exist",
    code: `// src/operations/storageOperations.ts

// Each user gets their own bucket for NFT assets
export async function ensureNftBucket(
  address: string
): Promise<string> {
  const storageHubClient = getStorageHubClient();
  const polkadotApi = getPolkadotApi();

  const bucketName = \`nft-assets-\${address.toLowerCase()}\`;

  // Deterministically derive bucket ID
  const bucketId = await storageHubClient.deriveBucketId(
    address,
    bucketName
  );

  // Check if bucket already exists on chain
  const bucket = await polkadotApi.query.providers.buckets(
    bucketId
  );
  if (!bucket.isEmpty) {
    return bucketId; // Already exists
  }

  // Create new bucket on-chain
  const { mspId } = await getMspInfo();
  const valuePropId = await getValueProps();

  const txHash = await storageHubClient.createBucket(
    mspId, bucketName, false, valuePropId
  );

  await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  return bucketId;
}`,
  },
  {
    id: 'uploadImage',
    title: 'Upload Image',
    tooltip: 'Uploads the image file to DataHaven storage',
    code: `// src/operations/storageOperations.ts

export async function uploadFileToDH(
  bucketId: string,
  fileName: string,
  fileData: Uint8Array,
  fileSize: number
): Promise<string> {
  // Create FileManager for hashing and streaming
  const fileManager = new FileManager({
    size: fileSize,
    stream: () => new ReadableStream({ ... }),
  });

  // Compute Merkle root fingerprint
  const fingerprint = await fileManager.getFingerprint();

  // Register file on-chain with MSP
  const txHash = await storageHubClient.issueStorageRequest(
    bucketId, fileName, fingerprint.toHex(),
    BigInt(fileSize), mspId, peerIds,
    ReplicationLevel.Custom, 1
  );

  // Derive unique file key
  const fileKey = await fileManager.computeFileKey(
    owner, bucketIdH256, fileName
  );

  // Upload actual file data to MSP
  const fileBlob = await fileManager.getFileBlob();
  await mspClient.files.uploadFile(
    bucketId, fileKey.toHex(), fileBlob,
    fingerprint.toHex(), address, fileName
  );

  return fileKey.toHex();
}`,
  },
  {
    id: 'uploadMetadata',
    title: 'Upload Metadata',
    tooltip: 'Uploads ERC-721 metadata JSON to DataHaven',
    code: `// src/pages/MintNFT.tsx

// ERC-721 metadata JSON stored on DataHaven
const metadata = {
  name: nftName,
  description: nftDescription,
  image: getDownloadUrl(imageFileKey), // Public DH download URL
};

// Convert to bytes and upload
const metadataJson = JSON.stringify(metadata, null, 2);
const encoder = new TextEncoder();
const metadataBytes = encoder.encode(metadataJson);

const metadataFileKey = await uploadFileToDH(
  bucketId,
  \`metadata-\${Date.now()}.json\`,
  metadataBytes,
  metadataBytes.length
);

// Wait for MSP on-chain confirmation
await waitForMSPConfirmOnChain(metadataFileKey);`,
  },
  {
    id: 'mintNft',
    title: 'Mint NFT',
    tooltip: 'Calls the mint function on the NFT smart contract',
    code: `// src/operations/nftOperations.ts

export async function mintNFT(
  metadataFileKey: string
): Promise<{ tokenId: number; txHash: string }> {
  const walletClient = getWalletClient();
  const publicClient = getPublicClient();

  // Call mint() on the NFT contract
  const txHash = await walletClient.writeContract({
    address: NFT_CONTRACT_ADDRESS,
    abi: NFT_CONTRACT_ABI,
    functionName: 'mint',
    args: [metadataFileKey], // tokenURI = DH file key
    chain,
    account: address,
  });

  const receipt = await publicClient
    .waitForTransactionReceipt({ hash: txHash });

  // Parse NFTMinted event to get tokenId
  for (const log of receipt.logs) {
    const decoded = decodeEventLog({
      abi: NFT_CONTRACT_ABI,
      data: log.data,
      topics: log.topics,
    });
    if (decoded.eventName === 'NFTMinted') {
      return {
        tokenId: Number(decoded.args.tokenId),
        txHash,
      };
    }
  }
}`,
  },
];

export const gallerySnippets: CodeSnippet[] = [
  {
    id: 'fetchNfts',
    title: 'Fetch NFTs',
    tooltip: 'Reads all NFTs from the contract and fetches their metadata',
    code: `// src/operations/nftOperations.ts

export async function fetchAllNFTs(): Promise<MintedNFT[]> {
  // Read total minted count from contract
  const totalSupply = await getTotalSupply();

  const nfts = [];
  for (let i = 0; i < totalSupply; i++) {
    // Get on-chain data for each token
    const [tokenURI, owner] = await Promise.all([
      getTokenURI(i),
      getOwnerOf(i),
    ]);

    // Fetch metadata JSON via public download URL
    let metadata = null;
    let imageUrl = null;
    try {
      const res = await fetch(getDownloadUrl(tokenURI));
      metadata = await res.json();

      // Image URL is already a public download URL
      imageUrl = metadata.image;
    } catch {
      // File may be expired — show placeholder
    }

    nfts.push({
      tokenId: i, owner, tokenURI,
      metadata, imageUrl,
    });
  }
  return nfts;
}`,
  },
  {
    id: 'deleteFiles',
    title: 'Delete Files',
    tooltip: 'Requests deletion of NFT files from DataHaven',
    code: `// src/operations/storageOperations.ts

// Request deletion of a single file from DataHaven
export async function requestDeleteFile(
  bucketId: string,
  fileKey: string
): Promise<void> {
  const mspClient = await connectToMsp();
  const storageHubClient = getStorageHubClient();
  const publicClient = getPublicClient();

  // Get file info from MSP (needed by SDK)
  const fileInfo = await mspClient.files.getFileInfo(
    bucketId, fileKey
  );

  // Submit deletion request on-chain
  const txHash = await storageHubClient.requestDeleteFile(
    fileInfo
  );

  const receipt = await publicClient
    .waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== 'success') {
    throw new Error('File deletion failed');
  }
}

// High-level helper: delete both NFT files
export async function deleteNftFiles(
  ownerAddress: string,
  metadataFileKey: string,
  imageFileKey: string | null
): Promise<void> {
  const bucketId = await deriveBucketIdForAddress(
    ownerAddress
  );
  await requestDeleteFile(bucketId, metadataFileKey);
  if (imageFileKey) {
    await requestDeleteFile(bucketId, imageFileKey);
  }
}`,
  },
  {
    id: 'updateNftFiles',
    title: 'Update NFT Files',
    tooltip: 'Uploads new files and updates the on-chain token URI',
    code: `// src/pages/Gallery.tsx — handleUpdateSubmit()

// 1. Ensure the user's NFT bucket exists
const bucketId = await ensureNftBucket(address);

// 2. Upload new image to DataHaven
const imageBytes = new Uint8Array(
  await editFile.arrayBuffer()
);
const imageFileKey = await uploadFileToDH(
  bucketId, imageName, imageBytes, imageBytes.length
);

// 3. Wait for MSP to confirm image on-chain
await waitForMSPConfirmOnChain(imageFileKey);

// 4. Build and upload new metadata JSON
const metadata = {
  name: editName,
  description: editDescription,
  image: getDownloadUrl(imageFileKey),
};
const metadataBytes = new TextEncoder().encode(
  JSON.stringify(metadata)
);
const metadataFileKey = await uploadFileToDH(
  bucketId, metadataName, metadataBytes,
  metadataBytes.length
);

// 5. Wait for metadata confirmation
await waitForMSPConfirmOnChain(metadataFileKey);

// 6. Update token URI on-chain to point to new metadata
await updateTokenURI(nft.tokenId, metadataFileKey);

// --- updateTokenURI() under the hood ---

// src/operations/nftOperations.ts
export async function updateTokenURI(
  tokenId: number,
  newMetadataFileKey: string
): Promise<string> {
  const walletClient = getWalletClient();
  const publicClient = getPublicClient();

  const txHash = await walletClient.writeContract({
    address: NFT_CONTRACT_ADDRESS,
    abi: NFT_CONTRACT_ABI,
    functionName: 'updateTokenURI',
    args: [BigInt(tokenId), newMetadataFileKey],
    chain,
    account: address,
  });

  const receipt = await publicClient
    .waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== 'success') {
    throw new Error('Update token URI failed');
  }

  return txHash;
}`,
  },
  {
    id: 'burnNft',
    title: 'Burn NFT',
    tooltip: 'Burns the NFT on-chain and deletes its DataHaven files',
    code: `// src/operations/nftOperations.ts

// Burn NFT on-chain and delete its DataHaven files
export async function burnNFT(
  tokenId: number,
  ownerAddress: string,
  metadataFileKey: string,
  imageFileKey: string | null
): Promise<string> {
  const walletClient = getWalletClient();
  const publicClient = getPublicClient();

  // 1. Burn the token on-chain
  const txHash = await walletClient.writeContract({
    address: NFT_CONTRACT_ADDRESS,
    abi: NFT_CONTRACT_ABI,
    functionName: 'burn',
    args: [BigInt(tokenId)],
    chain,
    account: address,
  });

  const receipt = await publicClient
    .waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== 'success') {
    throw new Error('Burn transaction failed');
  }

  // 2. Delete files from DataHaven (best-effort)
  try {
    await deleteNftFiles(
      ownerAddress, metadataFileKey, imageFileKey
    );
  } catch (err) {
    console.warn('NFT burned but file deletion failed:', err);
  }

  return txHash;
}`,
  },
];
