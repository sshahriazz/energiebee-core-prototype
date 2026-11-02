// Set the sign-in PIN of an existing account (delta 079): an account made before PINs (email and password),
// a demo user, or one that forgot its PIN. Unlocks the account and signs it out everywhere.
//
//   npm run user:pin -- <username> <4-digit PIN>                          the main database (.env DB_FILE)
//   DB_FILE=data/demo/core.db node scripts/set-pin.js <username> <PIN>    the demo database
const [username, pin] = process.argv.slice(2);
if (!username || !pin) { console.error('usage: npm run user:pin -- <username> <4-digit PIN>'); process.exit(2); }
const { setPin } = await import('../src/core/users.js');
const { closeDb } = await import('../src/db/db.js');
try {
  const u = setPin(username, pin);
  console.log(`PIN set for ${u.username} (user ${u.id}, ${u.name}): sign in with that username and PIN`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally { closeDb(); }
