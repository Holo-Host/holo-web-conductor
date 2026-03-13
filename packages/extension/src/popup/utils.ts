import { encodeHashToBase64 } from "@holochain/client";

type HashLike = Uint8Array | number[] | Record<string, number>;

/**
 * Ensure value is a real Uint8Array (Chrome messaging converts to plain objects)
 */
export function toUint8Array(data: HashLike): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  return new Uint8Array(Object.values(data));
}

/**
 * Format a HoloHash for display (truncated base64)
 */
export function formatHash(hash: HashLike): string {
  const b64 = encodeHashToBase64(toUint8Array(hash));
  return `${b64.substring(0, 12)}...${b64.substring(b64.length - 8)}`;
}

/**
 * Format a HoloHash to full base64
 */
export function formatHashFull(hash: HashLike): string {
  return encodeHashToBase64(toUint8Array(hash));
}

/**
 * Format timestamp as relative time (e.g. "2m ago", "3d ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Format timestamp as full date string
 */
export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Copy text to clipboard with visual feedback on the element
 */
export async function copyToClipboard(text: string, element: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    element.classList.add("copied");
    setTimeout(() => {
      element.classList.remove("copied");
    }, 2000);
  } catch (error) {
    console.error("Failed to copy:", error);
  }
}
