export async function readPasswordFromStdin(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4096) throw new Error('Password input exceeds the size limit');
    chunks.push(buffer);
  }
  const password = Buffer.concat(chunks).toString('utf8');
  validatePasswordInput(password);
  return password;
}

export function validatePasswordInput(password) {
  if (password.includes('\n') || password.includes('\r')) throw new Error('Password must be a single line; use printf instead of echo when piping');
  if (password.length < 12 || password.length > 256) {
    throw new Error(`Received ${password.length} characters; password must be 12-256 characters. The password itself was not displayed.`);
  }
}
