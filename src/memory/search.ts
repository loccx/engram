/**
 * Hybrid retrieval combining FTS5 (lexical) + sqlite-vec (semantic),
 * with query-adaptive signal weighting inspired by Attention Residuals
 * (arxiv 2603.15031).
 *
 * Public facade — implementations live in ./search/{scoring,hybrid,context,graph,duplicates}.ts.
 * MemorySearch class preserved for backward compatibility; delegates to free functions.
 *
 * Research: MemoryBank (2305.10250), FOREVER (2601.03938),
 *   RRF (Cormack et al. 2009), AttnRes (2603.15031)
 */

import type Database from 'better-sqlite3'
import type { Memory, SearchResult, MemoryCluster } from './types.js'
import {
  hybridSearch,
  type SearchOptions,
  DEFAULT_RERANK_TOP_N,
} from './search/hybrid.js'
import {
  prepareContextStatements,
  getContext,
  getClusters,
  type ContextStatements,
} from './search/context.js'
import { traverseGraph, pprSearch, type GraphResult } from './search/graph.js'
import { findDuplicates, type DuplicateGroup, type FindDuplicatesOptions } from './search/duplicates.js'
import {
  classifyQuery,
  WEIGHT_PROFILES,
  type QueryArchetype,
  type SignalKey,
} from './search/scoring.js'

export { classifyQuery, WEIGHT_PROFILES, DEFAULT_RERANK_TOP_N }
export type { QueryArchetype, SearchOptions, SignalKey, GraphResult, DuplicateGroup, FindDuplicatesOptions }

export class MemorySearch {
  private readonly contextStmts: ContextStatements

  constructor(
    private readonly db: Database.Database,
    private readonly vectorsAvailable: boolean = false
  ) {
    this.contextStmts = prepareContextStatements(db)
  }

  async hybridSearch(
    query: string,
    options: SearchOptions = {},
    signalBreakdown?: Map<string, Record<SignalKey, number>>
  ): Promise<SearchResult[]> {
    return hybridSearch(this.db, this.vectorsAvailable, query, options, signalBreakdown)
  }

  getContext(
    project_path: string,
    limit: number = 20,
    options: { include_superseded?: boolean; before?: number; as_of?: number } = {}
  ): Memory[] {
    return getContext(this.db, this.contextStmts, project_path, limit, options)
  }

  getClusters(projectPath: string): MemoryCluster[] {
    return getClusters(this.contextStmts, projectPath)
  }

  traverseGraph(
    startId: string,
    depth: number = 2,
    limit: number = 20,
    options: { include_superseded?: boolean; as_of?: number } = {}
  ): GraphResult[] {
    return traverseGraph(this.db, startId, depth, limit, options)
  }

  pprSearch(
    seedIds: string[],
    limit: number = 20,
    options: { include_superseded?: boolean; as_of?: number } = {}
  ): GraphResult[] {
    return pprSearch(this.db, seedIds, limit, options)
  }

  findDuplicates(options: FindDuplicatesOptions = {}): DuplicateGroup[] {
    return findDuplicates(this.db, this.vectorsAvailable, options)
  }
}
