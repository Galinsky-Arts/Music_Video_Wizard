import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM contract shared with Boardroom/Engine Room (no type declarations)
import { parsePrRegistry } from "../../../registry/pr-contract.mjs";

const root = path.resolve(__dirname, "../../..");
const body = readFileSync(path.join(root, "registry/prs.json"), "utf8");
const repository = "Galinsky-Arts/Music_Video_Wizard";

describe("registry/prs.json", () => {
  it("validates against the shared contract for the Galinsky-Arts repository", () => {
    expect(() => parsePrRegistry(body, repository)).not.toThrow();
    const retired = JSON.parse(readFileSync(path.join(root, "registry/roadmap.json"), "utf8"));
    expect(retired.repository).toBe(repository);
  });

  it("records PRs #67-#77 with canonical URLs and merge evidence", () => {
    const document = JSON.parse(body) as {
      pullRequests: Array<{ number: number; url: string; mergedAt: string | null; mergeCommitSha: string | null }>;
    };
    const numbers = new Set(document.pullRequests.map((pr) => pr.number));
    for (let number = 67; number <= 77; number += 1) expect(numbers.has(number), `#${number}`).toBe(true);
    expect(numbers.size).toBe(document.pullRequests.length);
    for (const pr of document.pullRequests) {
      expect(pr.url).toBe(`https://github.com/${repository}/pull/${pr.number}`);
      if (pr.number >= 67) expect(Boolean(pr.mergedAt)).toBe(Boolean(pr.mergeCommitSha));
    }
  });
});
