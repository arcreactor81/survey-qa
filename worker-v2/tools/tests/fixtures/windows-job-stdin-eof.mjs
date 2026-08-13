const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const bytes = Buffer.concat(chunks).length;
if (bytes !== 0) process.exit(2);
process.stdout.write(`${JSON.stringify({ bytes, ended: true })}\n`);
