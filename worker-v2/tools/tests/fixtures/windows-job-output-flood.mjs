import { spawn } from "node:child_process";
import { once } from "node:events";

const TRANSCRIPT_LIMIT_BYTES = 64 * 1024 * 1024;
const block = Buffer.alloc(64 * 1024, 0x78);

async function writeBytes(stream, totalBytes, finalByte = 0x78) {
  let written = 0;
  while (written < totalBytes) {
    const count = Math.min(block.length, totalBytes - written);
    const chunk = count === block.length ? block : Buffer.alloc(count, finalByte);
    if (!stream.write(chunk)) await once(stream, "drain");
    written += count;
  }
}

async function finishStream(stream) {
  stream.end();
  if (!stream.writableFinished) await once(stream, "finish");
}

const role = process.argv[2] ?? "descendant-flood";
if (role === "descendant-flood") {
  const child = spawn(process.execPath, [process.argv[1], "writer"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  child.unref();
  process.exit(0);
}

if (role === "exact-cap") {
  await writeBytes(process.stdout, TRANSCRIPT_LIMIT_BYTES);
  await finishStream(process.stdout);
  process.exit(0);
}

if (role === "cap-plus-one") {
  await writeBytes(process.stdout, TRANSCRIPT_LIMIT_BYTES + 1, 0x79);
  await finishStream(process.stdout);
  process.exit(0);
}

if (role === "dual-flood") {
  await Promise.all([
    writeBytes(process.stdout, 40 * 1024 * 1024, 0x6f),
    writeBytes(process.stderr, 40 * 1024 * 1024, 0x65),
  ]);
  await Promise.all([finishStream(process.stdout), finishStream(process.stderr)]);
  process.exit(0);
}

if (role !== "writer") process.exit(2);
function writeMore() {
  for (;;) {
    if (!process.stdout.write(block)) {
      process.stdout.once("drain", writeMore);
      return;
    }
  }
}
writeMore();
