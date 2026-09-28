/**
 * hybrid retrieval: fts5 plus sqlite-vec with query-adaptive signal weighting (attnres,
 * arxiv 2603.15031). this is the facade; search/{scoring,hybrid,context,graph,duplicates}.ts
 * holds the implementations.
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
import { traverseGraph, pprSearch, type GraphResult, type GraphWalkOptions } from './search/graph.js'
import { findDuplicates, type DuplicateGroup, type FindDuplicatesOptions } from './search/duplicates.js'
import {
  classifyQuery,
  WEIGHT_PROFILES,
  type QueryArchetype,
  type SignalKey,
} from './search/scoring.js'

export { classifyQuery, WEIGHT_PROFILES, DEFAULT_RERANK_TOP_N }
export type { QueryArchetype, SearchOptions, SignalKey, GraphResult, GraphWalkOptions, DuplicateGroup, FindDuplicatesOptions }

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
    options: GraphWalkOptions = {}
  ): GraphResult[] {
    return traverseGraph(this.db, startId, depth, limit, options)
  }

  pprSearch(
    seedIds: string[],
    limit: number = 20,
    options: GraphWalkOptions = {}
  ): GraphResult[] {
    return pprSearch(this.db, seedIds, limit, options)
  }

  findDuplicates(options: FindDuplicatesOptions = {}): DuplicateGroup[] {
    return findDuplicates(this.db, this.vectorsAvailable, options)
  }
}
