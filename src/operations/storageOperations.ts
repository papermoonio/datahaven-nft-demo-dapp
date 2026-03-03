import '@storagehub/api-augment';
import { FileManager, ReplicationLevel } from '@storagehub-sdk/core';
import { TypeRegistry } from '@polkadot/types';
import type { AccountId20, H256 } from '@polkadot/types/interfaces';
import { getStorageHubClient, getConnectedAddress, getPublicClient, getPolkadotApi } from '../services/clientService';
import {
  getMspClient,
  connectToMsp,
  getMspInfo,
  getValueProps,
  authenticateUser,
  isAuthenticated,
} from '../services/mspService';
import { NETWORK } from '../config/networks';
import type { PalletFileSystemStorageRequestMetadata } from '@polkadot/types/lookup';
import type { FileStatus } from '../types';
import type { StorageFileInfo } from '@storagehub-sdk/msp-client';

// Build a public download URL for a DataHaven file key
export function getDownloadUrl(fileKey: string): string {
  return NETWORK.mspUrl + 'download/' + fileKey;
}

// Bucket name prefix for NFT assets
const NFT_BUCKET_PREFIX = 'nft-assets-';

// Get the NFT bucket name for an address
export function getNftBucketName(address: string): string {
  return `${NFT_BUCKET_PREFIX}${address.toLowerCase()}`;
}

// Ensure the user's NFT bucket exists; create it if not
export async function ensureNftBucket(address: string): Promise<string> {
  const storageHubClient = getStorageHubClient();
  const polkadotApi = getPolkadotApi();

  const bucketName = getNftBucketName(address);
  const bucketId = (await storageHubClient.deriveBucketId(address as `0x${string}`, bucketName)) as string;

  // Check if bucket already exists on chain
  const bucketOnChain = await polkadotApi.query.providers.buckets(bucketId);
  if (!bucketOnChain.isEmpty) {
    // Bucket already exists, wait for backend indexing (might already be indexed)
    try {
      await waitForBackendBucketReady(bucketId);
    } catch {
      // If it times out, the bucket exists on-chain but backend is slow — proceed anyway
    }
    return bucketId;
  }

  // Create the bucket
  const { mspId } = await getMspInfo();
  const valuePropId = await getValueProps();

  const txHash: `0x${string}` | undefined = await storageHubClient.createBucket(
    mspId as `0x${string}`,
    bucketName,
    false, // public bucket so images are accessible
    valuePropId
  );

  if (!txHash) {
    throw new Error('createBucket() did not return a transaction hash');
  }

  const publicClient = getPublicClient();
  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (txReceipt.status !== 'success') {
    throw new Error(`Bucket creation failed: ${txHash}`);
  }

  // Verify on chain
  const bucketAfter = await polkadotApi.query.providers.buckets(bucketId);
  if (bucketAfter.isEmpty) {
    throw new Error('Bucket not found on chain after creation');
  }

  // Wait for backend to index
  await waitForBackendBucketReady(bucketId);

  return bucketId;
}

// Wait for backend to index the bucket
async function waitForBackendBucketReady(bucketId: string): Promise<void> {
  const mspClient = getMspClient();
  const maxAttempts = 10;
  const delayMs = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const bucket = await mspClient.buckets.getBucket(bucketId);
      if (bucket) {
        return;
      }
    } catch (error: unknown) {
      const err = error as { status?: number; body?: { error?: string } };
      if (err.status === 404 || err.body?.error === 'Not found: Record') {
        // Bucket not yet indexed, continue polling
      } else {
        throw error;
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Bucket ${bucketId} not found in MSP backend after waiting`);
}

// Upload a file to DataHaven (image or metadata JSON)
export async function uploadFileToDH(
  bucketId: string,
  fileName: string,
  fileData: Uint8Array,
  fileSize: number
): Promise<string> {
  const storageHubClient = getStorageHubClient();
  const publicClient = getPublicClient();
  const polkadotApi = getPolkadotApi();
  const mspClient = getMspClient();
  const address = getConnectedAddress();

  if (!address) {
    throw new Error('Wallet not connected');
  }

  // Create FileManager from raw bytes
  const fileManager = new FileManager({
    size: fileSize,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(fileData);
          controller.close();
        },
      }),
  });

  // Get file fingerprint (Merkle root)
  const fingerprint = await fileManager.getFingerprint();
  const fileSizeBigInt = BigInt(fileSize);

  // Get MSP details
  const { mspId, multiaddresses } = await getMspInfo();

  if (!multiaddresses?.length) {
    throw new Error('MSP multiaddresses are missing');
  }

  // Extract peer IDs
  const peerIds: string[] = (multiaddresses ?? [])
    .map((addr: string) => addr.split('/p2p/').pop())
    .filter((id: string | undefined): id is string => !!id);

  if (peerIds.length === 0) {
    throw new Error('MSP multiaddresses had no /p2p/<peerId> segment');
  }

  // Issue storage request on-chain
  const txHash: `0x${string}` | undefined = await storageHubClient.issueStorageRequest(
    bucketId as `0x${string}`,
    fileName,
    fingerprint.toHex() as `0x${string}`,
    fileSizeBigInt,
    mspId as `0x${string}`,
    peerIds,
    ReplicationLevel.Custom,
    1
  );

  if (!txHash) {
    throw new Error('issueStorageRequest() did not return a transaction hash');
  }

  // Wait for transaction
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`Storage request failed: ${txHash}`);
  }

  // Compute file key
  const registry = new TypeRegistry();
  const owner = registry.createType('AccountId20', address) as AccountId20;
  const bucketIdH256 = registry.createType('H256', bucketId) as H256;
  const fileKey = await fileManager.computeFileKey(owner, bucketIdH256, fileName);

  // Verify storage request on chain
  const storageRequest = await polkadotApi.query.fileSystem.storageRequests(fileKey);
  if (!(storageRequest as any).isSome) {
    throw new Error('Storage request not found on chain');
  }

  // Authenticate if not already
  if (!isAuthenticated()) {
    await authenticateUser();
  }

  // Upload file to MSP
  const fileBlob = await fileManager.getFileBlob();
  const uploadReceipt = await mspClient.files.uploadFile(
    bucketId as `0x${string}`,
    fileKey.toHex(),
    fileBlob,
    fingerprint.toHex(),
    address,
    fileName
  );

  if (uploadReceipt.status !== 'upload_successful') {
    throw new Error('File upload to MSP failed');
  }

  return fileKey.toHex();
}

// Wait for MSP to confirm on chain
export async function waitForMSPConfirmOnChain(fileKey: string): Promise<void> {
  const polkadotApi = getPolkadotApi();
  const maxAttempts = 20;
  const delayMs = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    console.log(
      `Check if storage request has been confirmed by the MSP on-chain, attempt ${i + 1} of ${maxAttempts}...`
    );

    const req = await polkadotApi.query.fileSystem.storageRequests(fileKey);
    if (req.isNone) {
      throw new Error(`StorageRequest for ${fileKey} no longer exists on-chain.`);
    }
    const data: PalletFileSystemStorageRequestMetadata = req.unwrap();
    // console.log('Storage request data:', data.toHuman());
    // MSP confirmation
    const mspStatus = data.mspStatus;
    console.log(`MSP confirmation status: ${mspStatus.type}`);

    const mspConfirmed = mspStatus.isAcceptedNewFile || mspStatus.isAcceptedExistingFile;

    if (mspConfirmed) {
      console.log('Storage request confirmed by MSP on-chain');
      return;
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`FileKey ${fileKey} not confirmed by MSP after waiting`);
}

// Wait for backend to mark file as ready
export async function waitForBackendFileReady(
  bucketId: `0x${string}`,
  fileKey: `0x${string}`
): Promise<StorageFileInfo> {
  const mspClient = getMspClient();
  const maxAttempts = 60;
  const delayMs = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const fileInfo = await mspClient.files.getFileInfo(bucketId, fileKey);

      if (fileInfo.status === 'ready') {
        return fileInfo;
      } else if (fileInfo.status === 'revoked') {
        throw new Error('File upload was cancelled by user');
      } else if (fileInfo.status === 'rejected') {
        throw new Error('File upload was rejected by MSP');
      } else if (fileInfo.status === 'expired') {
        throw new Error('Storage request expired');
      }
    } catch (error: unknown) {
      const err = error as { status?: number; body?: { error?: string } };
      if (err?.status === 404 || err?.body?.error === 'Not found: Record') {
        // File not yet indexed, continue waiting
      } else {
        throw error;
      }
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error('Timed out waiting for file to be ready');
}

// Check the current status of a file (single poll, not a loop)
// Returns the SDK FileStatus directly, or null if file not yet indexed (404)
export async function checkFileStatus(bucketId: `0x${string}`, fileKey: `0x${string}`): Promise<FileStatus | null> {
  const mspClient = await connectToMsp(); // lazy connect — fixes cases where MSP client isn't yet initialized

  // Ensure authenticated — getFileInfo requires auth
  if (!isAuthenticated()) {
    await authenticateUser();
  }

  try {
    const fileInfo = await mspClient.files.getFileInfo(bucketId, fileKey);
    return fileInfo.status; // return SDK status directly
  } catch (error: unknown) {
    const err = error as { status?: number; body?: { error?: string }; response?: { status?: number } };
    if (err?.status === 404 || err?.body?.error === 'Not found: Record') {
      return null; // file not yet indexed
    }
    // On 401, re-authenticate and retry once
    if (err?.status === 401 || err?.response?.status === 401) {
      await authenticateUser();
      try {
        const fileInfo = await mspClient.files.getFileInfo(bucketId, fileKey);
        return fileInfo.status;
      } catch (retryError: unknown) {
        const retryErr = retryError as { status?: number; body?: { error?: string } };
        if (retryErr?.status === 404 || retryErr?.body?.error === 'Not found: Record') {
          return null;
        }
        throw retryError;
      }
    }
    throw error; // re-throw unexpected errors
  }
}

// Extract raw file key from a public download URL
// e.g. "https://deo-dh-backend.testnet.datahaven-infra.network/download/0xabc..." → "0xabc..."
export function extractFileKeyFromUrl(url: string): `0x${string}` {
  const parts = url.split('/download/');
  if (parts.length < 2) {
    throw new Error(`Invalid download URL: ${url}`);
  }
  return parts[1] as `0x${string}`;
}

// Request deletion of a single file from DataHaven
export async function requestDeleteFile(bucketId: `0x${string}`, fileKey: `0x${string}`): Promise<void> {
  const mspClient = await connectToMsp();
  const storageHubClient = getStorageHubClient();
  const publicClient = getPublicClient();

  if (!isAuthenticated()) {
    await authenticateUser();
  }

  const fileInfo = await mspClient.files.getFileInfo(bucketId, fileKey);
  const txHash = await storageHubClient.requestDeleteFile(fileInfo);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== 'success') {
    throw new Error(`File deletion failed: ${txHash}`);
  }
}

// Delete both NFT files (metadata + image) from DataHaven
export async function deleteNftFiles(
  ownerAddress: `0x${string}`,
  metadataFileKey: `0x${string}`,
  imageFileKey: `0x${string}` | null
): Promise<void> {
  const bucketId = await deriveBucketIdForAddress(ownerAddress);
  await requestDeleteFile(bucketId, metadataFileKey);
  if (imageFileKey) {
    await requestDeleteFile(bucketId, imageFileKey);
  }
}

// Derive the NFT bucket ID for a given owner address
export async function deriveBucketIdForAddress(address: `0x${string}`): Promise<`0x${string}`> {
  const storageHubClient = getStorageHubClient();
  const bucketName = getNftBucketName(address);
  const bucketId = await storageHubClient.deriveBucketId(address, bucketName);
  if (!bucketId) {
    throw new Error(`deriveBucketId returned ${bucketId} for address ${address}`);
  }
  return bucketId as `0x${string}`;
}
