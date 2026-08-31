import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentError } from "../core/diagnostics.ts";

const execFileAsync = promisify(execFile);

export interface CheckpointSnapshot {
  head: string;
  clean: boolean;
}

export class GitCheckpoint {
  constructor(readonly workspaceRoot: string) {}

  async capture(): Promise<CheckpointSnapshot> {
    const head = await this.git("rev-parse", "HEAD");
    const clean = await this.isClean();
    return { head: head.trim(), clean };
  }

  async isClean(): Promise<boolean> {
    try {
      const status = await this.git("status", "--porcelain");
      return status.trim().length === 0;
    } catch (error) {
      throw new AgentError(
        `Failed to read git status: ${error instanceof Error ? error.message : String(error)}`,
        { code: "GIT_CHECKPOINT_STATUS_FAILED" },
      );
    }
  }

  async rollback(): Promise<void> {
    try {
      await this.git("checkout", ".");
    } catch (error) {
      throw new AgentError(
        `Failed to rollback working tree: ${error instanceof Error ? error.message : String(error)}`,
        { code: "GIT_ROLLBACK_FAILED" },
      );
    }
  }

  async diff(): Promise<string> {
    try {
      return await this.git("diff");
    } catch (error) {
      throw new AgentError(
        `Failed to read git diff: ${error instanceof Error ? error.message : String(error)}`,
        { code: "GIT_DIFF_FAILED" },
      );
    }
  }

  async commitAll(message: string): Promise<string> {
    try {
      await this.git("add", "-A");
      return await this.git("commit", "-m", message);
    } catch (error) {
      throw new AgentError(
        `Failed to commit changes: ${error instanceof Error ? error.message : String(error)}`,
        { code: "GIT_COMMIT_FAILED" },
      );
    }
  }

  private git(...args: string[]): Promise<string> {
    return execFileAsync("git", args, {
      cwd: this.workspaceRoot,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    }).then(({ stdout }) => stdout);
  }
}
