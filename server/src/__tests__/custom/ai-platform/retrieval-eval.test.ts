import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scope } from '@freellmapi/shared/ai-platform-retrieval.js';
import { getDb, initDb } from '../../../db/index.js';
import { addDoc, resetKnowledgeIndexes } from '../../../services/profile-knowledge.js';
import {
  retrieve,
  setQueryEmbeddingsRunnerForTests,
} from '../../../custom/ai-platform/retrieval/hybrid.js';
import {
  enqueueReindexJob,
  runPendingIndexJobsUntilIdle,
  setEmbeddingsRunnerForTests,
  stopIndexWorker,
} from '../../../custom/ai-platform/retrieval/indexer.js';
import { setRetrievalSettings } from '../../../custom/ai-platform/retrieval/settings.js';
import { invalidateVectorCache } from '../../../custom/ai-platform/retrieval/vector-store.js';
import { createFakeEmbeddingsRunner } from '../../helpers/fake-embeddings.js';

interface EvalChunk {
  id: string;
  docRef: string;
  docTitle: string;
  text: string;
}

interface EvalQuery {
  id: string;
  question: string;
  relevantChunkId: string;
}

interface EvalFixture {
  chunks: EvalChunk[];
  queries: EvalQuery[];
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(THIS_DIR, '../../fixtures/retrieval-eval.json');

function loadFixture(): EvalFixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as EvalFixture;
}

describe('ai-platform retrieval semantic evaluation suite (T076)', () => {
  beforeEach(async () => {
    await initDb(':memory:');
    resetKnowledgeIndexes();
    invalidateVectorCache();
  });

  afterEach(() => {
    stopIndexWorker();
    setEmbeddingsRunnerForTests(null);
    setQueryEmbeddingsRunnerForTests(null);
    invalidateVectorCache();
    resetKnowledgeIndexes();
    try {
      getDb()?.close?.();
    } catch {
      // ignore if already closed
    }
  });

  it('achieves at least +25 percentage points recall@5 improvement in hybrid over keyword baseline', async () => {
    const fixture = loadFixture();
    getDb()
      .prepare(
        `INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 'eval-profile', 'hash-eval-1', 'enc', 'iv', 'tag');

    const scope: Scope = { kind: 'profile', id: '1' };
    const docIdToChunkId = new Map<string, string>();

    for (const chunk of fixture.chunks) {
      const dbDocId = addDoc(1, chunk.docTitle, chunk.text);
      docIdToChunkId.set(String(dbDocId), chunk.id);
    }

    setRetrievalSettings(scope, {
      mode: 'hybrid',
      dimensions: 768,
      topK: 5,
      minScore: 0.25,
    });
    setEmbeddingsRunnerForTests(createFakeEmbeddingsRunner({ dims: 768 }));
    enqueueReindexJob(scope, 'reindex');
    await runPendingIndexJobsUntilIdle();

    let kwHitAt1 = 0;
    let kwHitAt5 = 0;
    let hybHitAt1 = 0;
    let hybHitAt5 = 0;

    const kwMisses: string[] = [];
    const hybMisses: string[] = [];

    for (const q of fixture.queries) {
      const kwRes = await retrieve(scope, q.question, { mode: 'keyword', topK: 5 });
      const kwChunkIds = kwRes.hits.map((h) => docIdToChunkId.get(h.docId));
      if (kwChunkIds[0] === q.relevantChunkId) kwHitAt1 += 1;
      if (kwChunkIds.includes(q.relevantChunkId)) {
        kwHitAt5 += 1;
      } else {
        kwMisses.push(`${q.id}:${q.relevantChunkId}`);
      }

      const hybRes = await retrieve(scope, q.question, { mode: 'hybrid', topK: 5 });
      expect(hybRes.degraded).toBe(false);
      expect(hybRes.modeUsed).toBe('hybrid');
      const hybChunkIds = hybRes.hits.map((h) => docIdToChunkId.get(h.docId));
      if (hybChunkIds[0] === q.relevantChunkId) hybHitAt1 += 1;
      if (hybChunkIds.includes(q.relevantChunkId)) {
        hybHitAt5 += 1;
      } else {
        hybMisses.push(`${q.id}:${q.relevantChunkId}(got=${hybChunkIds.join(',')})`);
      }
    }

    const total = fixture.queries.length;
    const kwRecall5 = kwHitAt5 / total;
    const hybRecall5 = hybHitAt5 / total;
    const lift = hybRecall5 - kwRecall5;

    // Emit metrics clearly in test output for visibility
    console.info(
      `[retrieval-eval] total=${total} kw_recall@1=${(kwHitAt1 / total).toFixed(3)} kw_recall@5=${kwRecall5.toFixed(3)} hyb_recall@1=${(hybHitAt1 / total).toFixed(3)} hyb_recall@5=${hybRecall5.toFixed(3)} lift=${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(1)}pp kwMisses=${kwMisses.length} hybMisses=[${hybMisses.join('; ')}]`,
    );

    expect(total).toBeGreaterThanOrEqual(50);
    expect(hybRecall5).toBeGreaterThanOrEqual(0.85);
    expect(lift).toBeGreaterThanOrEqual(0.25);
  });
});
