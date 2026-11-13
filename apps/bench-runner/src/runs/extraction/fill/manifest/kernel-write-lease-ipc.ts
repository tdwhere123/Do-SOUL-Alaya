import { tmpdir } from "node:os";
import { dirname } from "node:path";

/** Isolation may admit these lock sockets; they are not a provider network channel. */
export function isKernelWriteLeaseIpcAddress(address: string): boolean {
  const linuxPrefix = "\0alaya-extraction-cache-write-";
  if (address.startsWith(linuxPrefix)) return /^[0-9a-f]{64}$/u.test(address.slice(linuxPrefix.length));
  const windowsPrefix = `${String.fromCharCode(92)}${String.fromCharCode(92)}.${String.fromCharCode(92)}pipe${String.fromCharCode(92)}alaya-w-`;
  if (address.startsWith(windowsPrefix)) return /^[0-9a-f]{16}$/u.test(address.slice(windowsPrefix.length));
  return /(?:^|[/\\])alaya-w-[0-9a-f]{16}\.sock$/u.test(address)
    && (dirname(address) === "/tmp" || dirname(address) === tmpdir());
}
