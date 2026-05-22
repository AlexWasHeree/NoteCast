import {
  CLASSIFY_HINT_THRESHOLD,
  CLASSIFY_HINT_TOP_K,
  CLASSIFY_MAX_BATCH,
} from '../../application/scans/classify/classify.usecase';
import {
  ADD_PARENT_THRESHOLD,
  CONSOLIDATE_AFFINITY_DEMOTION_MARGIN,
  CONSOLIDATE_AFFINITY_MIN_MARGIN,
  CONSOLIDATE_MULTI_ASSIGN_ANCHOR_MIN_SCORE,
  CONSOLIDATE_MULTI_ASSIGN_MIN_SCORE,
  REMOVE_PARENT_THRESHOLD,
  REROUTE_LINK_RATIO,
} from '../../application/scans/consolidate/consolidate.usecase';
import {
  ORGANIZE_MULTI_ASSIGN_ANCHOR_MIN_SCORE,
  ORGANIZE_MULTI_ASSIGN_MIN_SCORE,
} from '../../application/scans/organize/organize.usecase';
import { INTERIOR_NODE_WEIGHT } from '../../application/scans/shared/scan.shared';
import { SPLIT_MIN_CLUSTER } from '../../application/scans/shared/scan.splits';
import type { UserConfig } from '../config/config.types';
import { getPrompts } from '../llm/prompts';
import {
  CLUSTER_THRESHOLD,
  GRAPH_THRESHOLD,
  GRAPH_TOP_K,
  INTRA_DEPTH_INCREMENT,
  INTRA_THEME_CLUSTER_THRESHOLD,
} from '../vector/vector.utils';

export interface CalibrationReport {
  thresholds: {
    clusterThreshold: number;
    intraThemeClusterBase: number;
    intraDepthIncrement: number;
    splitMinCluster: number;
    classifyHintThreshold: number;
    classifyHintTopK: number;
    classifyMaxBatch: number;
    organizeMultiAssignMin: number;
    organizeMultiAssignAnchorMin: number;
    rerouteLinkRatio: number;
    addParentThreshold: number;
    removeParentThreshold: number;
    consolidateAffinityMinMargin: number;
    consolidateAffinityDemotionMargin: number;
    consolidateMultiAssignMin: number;
    consolidateMultiAssignAnchorMin: number;
    interiorNodeWeight: number;
    graphThreshold: number;
    graphTopK: number;
  };
  config: {
    themeStyle: string;
    themeStyleInstruction?: string;
    baseThemes: { name: string; description?: string }[];
    pipelineConfig: {
      classifyEvery: number;
      organizeAfterClassifies: number;
      consolidateAfterOrganizes: number;
    };
  };
  prompts: {
    classify: string;
    classifyJsonSchema: string;
    classifyStyleInstructions: Record<string, string>;
    organizeBase: string;
    consolidateBase: string;
  };
}

export function collectCalibration(userConfig: UserConfig): CalibrationReport {
  const prompts = getPrompts(userConfig.language ?? 'english');
  return {
    thresholds: {
      clusterThreshold: CLUSTER_THRESHOLD,
      intraThemeClusterBase: INTRA_THEME_CLUSTER_THRESHOLD,
      intraDepthIncrement: INTRA_DEPTH_INCREMENT,
      splitMinCluster: SPLIT_MIN_CLUSTER,
      classifyHintThreshold: CLASSIFY_HINT_THRESHOLD,
      classifyHintTopK: CLASSIFY_HINT_TOP_K,
      classifyMaxBatch: CLASSIFY_MAX_BATCH,
      organizeMultiAssignMin: ORGANIZE_MULTI_ASSIGN_MIN_SCORE,
      organizeMultiAssignAnchorMin: ORGANIZE_MULTI_ASSIGN_ANCHOR_MIN_SCORE,
      rerouteLinkRatio: REROUTE_LINK_RATIO,
      addParentThreshold: ADD_PARENT_THRESHOLD,
      removeParentThreshold: REMOVE_PARENT_THRESHOLD,
      consolidateAffinityMinMargin: CONSOLIDATE_AFFINITY_MIN_MARGIN,
      consolidateAffinityDemotionMargin: CONSOLIDATE_AFFINITY_DEMOTION_MARGIN,
      consolidateMultiAssignMin: CONSOLIDATE_MULTI_ASSIGN_MIN_SCORE,
      consolidateMultiAssignAnchorMin: CONSOLIDATE_MULTI_ASSIGN_ANCHOR_MIN_SCORE,
      interiorNodeWeight: INTERIOR_NODE_WEIGHT,
      graphThreshold: GRAPH_THRESHOLD,
      graphTopK: GRAPH_TOP_K,
    },
    config: {
      themeStyle: userConfig.themeStyle,
      ...(userConfig.themeStyleInstruction !== undefined
        ? { themeStyleInstruction: userConfig.themeStyleInstruction }
        : {}),
      baseThemes: userConfig.baseThemes,
      pipelineConfig: userConfig.pipelineConfig,
    },
    prompts: {
      classify: prompts.classifyBase,
      classifyJsonSchema: prompts.classifyJsonSchema,
      classifyStyleInstructions: prompts.styleInstructions,
      organizeBase: prompts.organizeBase,
      consolidateBase: prompts.consolidateBase,
    },
  };
}
