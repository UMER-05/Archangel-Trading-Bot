// backend/src/services/tokenExtraction.service.ts
//
// The CandidateMint shape every stage of the discovery -> validate -> buy
// pipeline (candidatePipeline, execution router, native executors) consumes.
//
// Discovery is now driven solely by the Solami Blur stream; the adapter that
// produces this shape lives in blurExtraction.service.ts. The old webhook
// payload extractor that used to live in this file has been removed. The file
// keeps its name only so existing `import type { CandidateMint }` lines
// elsewhere don't need to change.
export interface CandidateMint {
  mint: string;
  poolAddress: string;
  dex: string;
  poolCreatedAt: Date;
}
