// scripts/_runner.js
async function runMain(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err && err.stack || err);
    process.exitCode = 1; // allowed by n/no-process-exit
  }
}
module.exports = { runMain };
