import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AgentError } from "../core/diagnostics.ts";

const execFileAsync = promisify(execFile);

export interface CheckpointSnapshot {
  head: string;
  clean: boolean;
  pendingDiff?: string;
}

export class GitCheckpoint {
  private lastSnapshot?: CheckpointSnapshot;

  constructor(readonly workspaceRoot: string) {}

  async capture(): Promise<CheckpointSnapshot> {
    const head = await this.git("rev-parse", "HEAD");
    const clean = await this.isClean();
    const pendingDiff = clean ? undefined : await this.diff();
    const snapshot: CheckpointSnapshot = {
      head: head.trim(),
      clean,
      pendingDiff,
    };
    this.lastSnapshot = snapshot;
    return snapshot;
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
      const snapshot = this.lastSnapshot;
      if (snapshot?.pendingDiff) {
        await this.applyDiff(snapshot.pendingDiff);
      }
    } catch (error) {
      throw new AgentError(
        `Failed to rollback working tree: ${error instanceof Error ? error.message : String(error)}`,
        { code: "GIT_ROLLBACK_FAILED" },
      );
    }
  }

  private async applyDiff(diff: string): Promise<void> {
    const patchPath = path.join(
      tmpdir(),
      `reallity-pending-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`,
    );
    writeFileSync(patchPath, diff, "utf8");
    try {
      await this.git("apply", patchPath);
    } finally {
      rmSync(patchPath, { force: true });
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

  async status(): Promise<string> {
    try {
      return await this.git("status", "--porcelain");
    } catch (error) {
      throw new AgentError(
        `Failed to read git status: ${error instanceof Error ? error.message : String(error)}`,
        { code: "GIT_STATUS_FAILED" },
      );
    }
  }

  async hasChanges(): Promise<boolean> {
    const status = await this.status();
    return status.trim().length > 0;
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
