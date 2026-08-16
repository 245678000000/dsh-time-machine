import { spawn } from "node:child_process";

export async function runValidationCommands(
  cwd: string,
  commands: string[],
): Promise<{
  status: "pass" | "fail" | "skipped";
  results: Array<{ command: string; exitCode: number; passed: boolean; output?: string }>;
}> {
  if (commands.length === 0) return { status: "skipped", results: [] };
  const results: Array<{ command: string; exitCode: number; passed: boolean; output?: string }> = [];
  for (const command of commands) {
    const result = await runOne(cwd, command);
    results.push(result);
    if (!result.passed) return { status: "fail", results };
  }
  return { status: "pass", results };
}

function runOne(
  cwd: string,
  command: string,
): Promise<{ command: string; exitCode: number; passed: boolean; output?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => {
      output += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ command, exitCode: 1, passed: false, output: err.message });
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolve({
        command,
        exitCode,
        passed: exitCode === 0,
        output: output.slice(-4000),
      });
    });
  });
}
