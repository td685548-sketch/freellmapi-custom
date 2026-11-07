import { describe, expect, it } from 'vitest';
import {
  getRtkStats,
  recordRtkCompression,
  filterGitStatus,
  filterGitDiff,
  filterBuildOutput,
  filterReadNumbered,
  smartTruncate,
  autoDetectFilter,
  compressToolOutput,
  compressMessages,
} from '../../custom/x-gateway/rtk.js';

describe('RTK (Runtime Tool-Result Compressor)', () => {
  describe('filterGitStatus', () => {
    it('returns Clean working tree for empty input', () => {
      expect(filterGitStatus('')).toContain('Clean working tree');
      expect(filterGitStatus('   \n  ')).toContain('Clean working tree');
    });

    it('compresses porcelain git status format', () => {
      const porcelain = [
        '## main...origin/main',
        'M  src/app.ts',
        ' M src/utils.ts',
        '?? untracked.js',
      ].join('\n');

      const result = filterGitStatus(porcelain);
      expect(result).toContain('* main...origin/main');
      expect(result).toContain('+ Staged: 1 files');
      expect(result).toContain('~ Modified: 1 files');
      expect(result).toContain('? Untracked: 1 files');
    });

    it('compresses standard long git status format', () => {
      const gitStatusOutput = [
        'On branch main',
        'Your branch is up to date with \'origin/main\'.',
        '',
        'Changes to be committed:',
        '  (use "git restore --staged <file>..." to unstage)',
        '        modified:   src/index.ts',
        '',
        'Untracked files:',
        '  (use "git add <file>..." to include in what will be committed)',
        '        temp.txt',
      ].join('\n');

      const result = filterGitStatus(gitStatusOutput);
      expect(result).toContain('* main');
      expect(result).not.toContain('use "git restore');
    });
  });

  describe('filterGitDiff', () => {
    it('strips index hashes and retains file headers and diff hunks', () => {
      const diffInput = [
        'diff --git a/src/test.ts b/src/test.ts',
        'index 83a45c1..b2e8412 100644',
        '--- a/src/test.ts',
        '+++ b/src/test.ts',
        '@@ -1,3 +1,4 @@',
        ' import { describe } from "vitest";',
        '+// Added comment',
        ' const a = 1;',
      ].join('\n');

      const result = filterGitDiff(diffInput);
      expect(result).toContain('diff: src/test.ts');
      expect(result).not.toContain('index 83a45c1..b2e8412');
      expect(result).toContain('+// Added comment');
    });
  });

  describe('filterBuildOutput', () => {
    it('filters noisy progress and retains errors and warnings', () => {
      const buildLog = [
        '> project@1.0.0 build',
        'Compiling package 1/50...',
        'Compiling package 2/50...',
        'added 142 packages in 1.2s',
        'npm warn deprecated package-foo@1.0.0: Please upgrade',
        'ERROR: Failed to compile module src/broken.ts',
        '  line 12: unexpected token',
        'BUILD FAILED in 2s',
      ].join('\n');

      const result = filterBuildOutput(buildLog);
      expect(result).toContain('npm warn');
      expect(result).toContain('ERROR: Failed to compile module src/broken.ts');
      expect(result).toContain('BUILD FAILED');
      expect(result).not.toContain('Compiling package 1/50');
    });
  });

  describe('filterReadNumbered', () => {
    it('cleans numbered lines from tool outputs', () => {
      const numbered = [
        '  1\timport express from "express";',
        '  2\t',
        '  3\tconst app = express();',
        '  4\tapp.listen(3000);',
      ].join('\n');

      const result = filterReadNumbered(numbered);
      expect(result).toContain('import express from "express";');
      expect(result).toContain('app.listen(3000);');
    });
  });

  describe('smartTruncate', () => {
    it('leaves inputs within limits intact', () => {
      const short = 'Line 1\nLine 2\nLine 3';
      expect(smartTruncate(short)).toBe(short);
    });

    it('truncates inputs exceeding line threshold and inserts omission marker', () => {
      const lines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join('\n');
      const truncated = smartTruncate(lines);
      expect(truncated).toContain('Line 1');
      expect(truncated).toContain('Line 60');
      expect(truncated).toContain('compressed/truncated');
      expect(truncated.split('\n').length).toBeLessThan(60);
    });
  });

  describe('autoDetectFilter', () => {
    it('detects git status', () => {
      const filter = autoDetectFilter('On branch feature-x\nnothing to commit');
      expect(filter?.name).toBe('git-status');
    });

    it('detects git diff', () => {
      const filter = autoDetectFilter('diff --git a/file b/file\n@@ -1 +1 @@');
      expect(filter?.name).toBe('git-diff');
    });

    it('detects build output', () => {
      const filter = autoDetectFilter('npm error missing dependency\nBUILD FAILED');
      expect(filter?.name).toBe('build-output');
    });

    it('returns null for generic text without tool patterns', () => {
      expect(autoDetectFilter('A regular response without tool patterns')).toBeNull();
    });
  });

  describe('compressToolOutput and stats', () => {
    it('compresses tool output and tracks saved bytes', () => {
      const gitStatus = [
        '## main...origin/main',
        'M  src/components/dashboard/overview-metrics.tsx',
        'M  src/components/navigation/sidebar-links.tsx',
        'M  src/lib/analytics/token-usage-reporter.ts',
        '?? tests/fixtures/sample-git-repository-diff.txt',
        '?? tests/fixtures/sample-build-log-output.log',
      ].join('\n');

      const res = compressToolOutput(gitStatus);
      expect(res.filter).toBe('git-status');
      expect(res.bytesSaved).toBeGreaterThanOrEqual(0);
      expect(res.compressed).toContain('* main');
    });

    it('records compression statistics in memory', () => {
      const beforeStats = getRtkStats();
      recordRtkCompression('git-status', 1000, 400);
      const afterStats = getRtkStats();

      expect(afterStats.totalCompressions).toBe(beforeStats.totalCompressions + 1);
      expect(afterStats.bytesBefore).toBe(beforeStats.bytesBefore + 1000);
      expect(afterStats.bytesAfter).toBe(beforeStats.bytesAfter + 400);
      expect(afterStats.tokensSavedEst).toBe(beforeStats.tokensSavedEst + 150);
      expect(afterStats.filterHits['git-status']).toBeGreaterThanOrEqual(1);
    });
  });

  describe('compressMessages', () => {
    it('compresses tool messages when RTK is active', () => {
      const porcelain = '## main\n' + Array.from({ length: 50 }, (_, i) => `M  file${i}.ts`).join('\n');
      const body = {
        messages: [
          { role: 'user', content: 'run git status' },
          {
            role: 'tool',
            content: porcelain,
          },
        ],
      };

      const result = compressMessages(body, true);
      expect(result).not.toBeNull();
      expect(result!.hits.length).toBeGreaterThan(0);
      expect(result!.bytesBefore).toBeGreaterThan(result!.bytesAfter);
      expect((body.messages[1].content as string)).toContain('* main');
    });

    it('handles non-tool messages without modification', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Hello assistant' },
          { role: 'assistant', content: 'Hello user' },
        ],
      };

      const result = compressMessages(body, true);
      expect(result).toBeNull();
    });
  });
});
