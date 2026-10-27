// Entry point for `npm run seed`. `.env` is loaded by Node's --env-file-if-exists flag.
import { fixtures } from './fixtures.js';
import { mongoSeedWriter } from './mongo-writer.js';
import { runSeed } from './seed.js';

process.exitCode = await runSeed({
  env: process.env,
  fixtures,
  writer: mongoSeedWriter,
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  },
});
