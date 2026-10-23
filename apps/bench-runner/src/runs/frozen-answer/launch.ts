import { runFrozenAnswerCommand } from "./command.js";
process.exitCode = await runFrozenAnswerCommand(process.argv.slice(2));
