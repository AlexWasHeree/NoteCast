export type Language = 'portuguese' | 'english';

export interface SplitLabels {
  topicsLabel: string;
  noTopicsLabel: string;
  clusterLabel: (index: number, count: number) => string;
  existingSubthemesLabel: string;
  siblingsLabel: string;
  topFreqTopicsLabel: string;
  overlapLabel: string;
}

export interface RedistributionLabels {
  noteLabel: string;
  summaryLabel: string;
  noSummaryLabel: string;
  topicsLabel: string;
  noTopicsLabel: string;
  currentThemeLabel: string;
  suggestedThemeLabel: string;
  neighborsLabel: string;
  noNeighborsLabel: string;
  noThemeLabel: string;
  relatedThemePrefix: string;
  affinityLabel: string;
  marginLabel: string;
  candidatesLabel: string;
  jsonInstruction: string;
}

export interface ConnectionLabels {
  themeLabel: string;
  currentParentsLabel: string;
  rootLabel: string;
  proposedLabel: string;
  disconnectLabel: string;
  cooccurrenceLabel: string;
  notesSuffix: string;
}

export interface MultiAssignLabels {
  topicsLabel: string;
  noTopicsLabel: string;
  currentThemesLabel: string;
  candidateLabel: string;
  jsonInstruction: string;
}

export interface ReasonLabels {
  affinity: (pct: string) => string;
  neighbors: (k: number, n: number) => string;
  topics: (topics: string) => string;
  semanticDesc: string;
}

export interface Prompts {
  summary: string;
  classifyBase: string;
  styleInstructions: Record<string, string>;
  baseThemesHeader: string;
  classifyThemesHeader: string;
  classifyNotesHeader: string;
  classifyHintLabel: string;
  classifyNoThemesLabel: string;
  classifyOtherThemesLabel: string;
  classifyJsonSchema: string;
  classifyAssignmentsNote: string;
  contextLabel: string;
  splitInstruction: string;
  splitDepthCaution: (depth: number) => string;
  splitResidualNote: (count: number) => string;
  splitLabels: SplitLabels;
  multiAssignInstruction: string;
  multiAssignLabels: MultiAssignLabels;
  organizeBase: string;
  consolidateBase: string;
  rerouteInstruction: string;
  rerouteLabels: RedistributionLabels;
  affinityInstruction: string;
  affinityLabels: RedistributionLabels;
  connectionsAddVerb: string;
  connectionsRemoveVerb: string;
  connectionsHighReason: string;
  connectionsLowReason: string;
  connectionsSemanticNote: string;
  connectionLabels: ConnectionLabels;
  connectionsJsonNote: (field: string) => string;
  connectionsAnalyzeInstruction: (verb: string, reason: string, semanticNote: string) => string;
  reasonLabels: ReasonLabels;
  summaryPromptLabels: {
    titleLabel: string;
    contentLabel: string;
  };
  noteFormatterLabels: {
    summaryLabel: string;
    noSummaryLabel: string;
    topicsLabel: string;
    noTopicsLabel: string;
  };
  splitFallbackInstruction: string;
  splitJsonInstruction: string;
}

const PORTUGUESE: Prompts = {
  summary: `Você é um assistente de síntese de notas pessoais estilo Zettelkasten.

Dado o título e conteúdo de uma nota, escreva um resumo em 2 a 3 frases curtas.

Regras obrigatórias:
- Capture a ideia central e os pontos mais relevantes
- Responda em português
- Texto corrido apenas — sem markdown, sem listas, sem títulos, sem bullet points
- Sem frase introdutória ("Esta nota fala de...", "Aqui está um resumo...")
- Responda APENAS com as frases do resumo, nada mais`,

  classifyBase: `Você é especialista em Zettelkasten e Arquitetura de Informação (referência: Sönke Ahrens - Como fazer anotações inteligentes).
Cada nota é apresentada com título, resumo gerado por IA e tópicos extraídos automaticamente — use os tópicos como sinal primário de categorização.
Regras: Não converse, apenas processe. Retorne APENAS um JSON válido, sem markdown ou texto extra.
NÃO crie temas novos — use apenas os temas listados.
Cada nota pode pertencer a 1, 2 ou até 3 temas. Atribua múltiplos temas quando a nota genuinamente cruza domínios — não force multi-atribuição.
PRIORIDADE DE ESPECIFICIDADE: sempre prefira o subtema mais específico ao tema pai. Se existir um subtema que cobre o assunto, atribua SOMENTE ao subtema — nunca ao subtema E ao pai ao mesmo tempo. Só atribua a um tema genérico/raiz quando nenhum subtema existente se encaixar.`,

  styleInstructions: {
    'single-word': 'Crie nomes de temas com apenas uma palavra.',
    'short-phrase': 'Crie nomes de temas com 2-4 palavras.',
    descriptive: 'Crie nomes de temas descritivos e específicos (5-10 palavras).',
  },

  baseThemesHeader:
    'Temas base do usuário (respeite como âncoras — associe notas a eles ou aos seus subtemas, nunca os ignore):',
  classifyThemesHeader: 'Temas existentes:',
  classifyNotesHeader: 'Notas a categorizar (associe cada nota a 1+ temas existentes):',
  classifyHintLabel: 'Classificações anteriores sugerem fortemente:',
  classifyNoThemesLabel: '(nenhum tema cadastrado)',
  classifyOtherThemesLabel: 'Outros temas existentes:',
  classifyJsonSchema: `{
  "assignments": [{"noteId": "string", "themeNames": ["string"]}]
}
O campo noteId deve ser o UUID mostrado como [ID: ...] na nota. Não use o título da nota.`,
  classifyAssignmentsNote:
    '- assignments: para cada nota, themeNames dos temas existentes (nomes exatos da lista)\n- Use 1 tema quando a nota é claramente de uma área. Use 2+ quando cruza áreas distintas.',

  contextLabel: 'Contexto do usuário:',

  splitInstruction: `Abaixo estão clusters de notas detectados algoritmicamente dentro de um tema.
Cada cluster é um agrupamento vetorial — notas semanticamente próximas entre si.
Para cada cluster, sugira um nome de subtema que capture o assunto comum.
Não sugira subtemas redundantes com temas irmãos existentes.
Se um cluster não representa um subassunto coeso, retorne-o com name vazio para ignorá-lo.`,

  splitDepthCaution: (depth) =>
    depth >= 2
      ? `\nProfundidade ${depth} — seja criterioso: só proponha subtemas com subgrupos semânticos muito claros.`
      : '',

  splitResidualNote: (count) =>
    `(${count} notas permanecem no tema pai por não pertencerem a nenhum cluster)`,

  splitLabels: {
    topicsLabel: 'Tópicos:',
    noTopicsLabel: '(sem)',
    clusterLabel: (index, count) => `Cluster ${index + 1} (${count} notas):`,
    existingSubthemesLabel: 'Subtemas já existentes (NÃO repita esses nomes):',
    siblingsLabel: 'Temas irmãos existentes:',
    topFreqTopicsLabel: 'Tópicos mais frequentes:',
    overlapLabel: 'Overlap com outros temas:',
  },

  multiAssignInstruction: `Analise candidatos de atribuição múltipla: notas que têm conteúdo relevante para mais de um tema.
Temas-âncora marcados com ★ foram criados pelo usuário — aprove quando a nota tiver conteúdo relacionado à área, mesmo que não seja o foco principal.
Para temas sem ★, aprove quando a nota tratar diretamente do assunto do tema.
O modelo semântico já pré-filtrou os candidatos mais relevantes — prefira aprovar na dúvida.`,

  multiAssignLabels: {
    topicsLabel: 'Tópicos:',
    noTopicsLabel: '(sem)',
    currentThemesLabel: 'Temas atuais:',
    candidateLabel: 'Tema candidato:',
    jsonInstruction: `Retorne JSON: {"multiAssignments": [{"noteId": "uuid-da-nota", "themeId": "uuid-ou-nome-exato-do-tema"}]}
noteId é o UUID mostrado como [ID: ...]. themeId pode ser o UUID ou nome exato do tema. Array vazio se nenhuma atribuição válida.`,
  },

  organizeBase: `Você é especialista em Zettelkasten e Arquitetura de Informação (referência: Sönke Ahrens - Como fazer anotações inteligentes).
Regras: Não converse, apenas processe. Retorne APENAS um JSON válido, sem markdown ou texto extra.`,

  consolidateBase: `Você é especialista em Zettelkasten e Arquitetura de Informação (referência: Sönke Ahrens - Como fazer anotações inteligentes).
Foco: coesão e granularidade de temas. Mantenha a consistência da organização.
Regras: Não converse, apenas processe. Retorne APENAS um JSON válido, sem markdown ou texto extra.`,

  rerouteInstruction: `Analise se as notas abaixo estão melhor classificadas em outro tema.
Cada nota mostra seu grafo de vizinhos semânticos (relatedNotes) e os temas desses vizinhos.
O link ratio indica a fração de vizinhos no tema sugerido. Use o conteúdo semântico para validar.`,

  rerouteLabels: {
    noteLabel: 'Nota',
    summaryLabel: 'Resumo:',
    noSummaryLabel: '(sem resumo)',
    topicsLabel: 'Tópicos:',
    noTopicsLabel: '(sem)',
    currentThemeLabel: 'Tema atual',
    suggestedThemeLabel: 'Tema sugerido',
    neighborsLabel: 'Vizinhos semânticos:',
    noNeighborsLabel: '(sem vizinhos)',
    noThemeLabel: '(sem tema)',
    relatedThemePrefix: 'tema:',
    affinityLabel: 'afinidade:',
    marginLabel: 'Margem:',
    candidatesLabel: 'Candidatos:',
    jsonInstruction: `Retorne JSON: {"redistributions": [{"noteId": "string", "fromThemeId": "string", "toThemeId": "string"}]}
Inclua apenas as notas que realmente devem mover. Array vazio se nenhuma.`,
  },

  affinityInstruction: `Analise se as notas abaixo estão melhor classificadas em outro tema.
A margem de afinidade indica quanto o tema candidato é vetorialmente mais próximo que o tema atual.
Use o conteúdo semântico (título, resumo, tópicos) para a decisão final — afinidade vetorial é um sinal, não uma verdade.`,

  affinityLabels: {
    noteLabel: 'Nota',
    summaryLabel: 'Resumo:',
    noSummaryLabel: '(sem resumo)',
    topicsLabel: 'Tópicos:',
    noTopicsLabel: '(sem)',
    currentThemeLabel: 'Tema atual',
    suggestedThemeLabel: 'Tema sugerido',
    neighborsLabel: 'Vizinhos semânticos:',
    noNeighborsLabel: '(sem vizinhos)',
    noThemeLabel: '(sem tema)',
    relatedThemePrefix: 'tema:',
    affinityLabel: 'afinidade:',
    marginLabel: 'Margem:',
    candidatesLabel: 'Candidatos:',
    jsonInstruction: `Retorne JSON: {"redistributions": [{"noteId": "string", "fromThemeId": "string", "toThemeId": "string"}]}
Inclua apenas as notas que realmente devem mover. Array vazio se nenhuma.`,
  },

  connectionsAddVerb: 'conectar',
  connectionsRemoveVerb: 'desconectar',
  connectionsHighReason: 'Alta coocorrência de notas indica que esses temas são relacionados.',
  connectionsLowReason: 'Baixa coocorrência indica que a conexão já não reflete a realidade.',
  connectionsSemanticNote: 'Use o contexto semântico para a decisão final.',

  connectionLabels: {
    themeLabel: 'Tema:',
    currentParentsLabel: 'Parents atuais:',
    rootLabel: '(raiz)',
    proposedLabel: 'Conexão proposta:',
    disconnectLabel: 'Desconexão proposta:',
    cooccurrenceLabel: 'coocorrência:',
    notesSuffix: 'notas',
  },

  connectionsJsonNote: (field) =>
    `Retorne JSON: {"${field}": [{"themeId": "string", "parentId": "string"}]}\nInclua apenas as conexões que fazem sentido. Array vazio se nenhuma.`,

  connectionsAnalyzeInstruction: (verb, reason, semanticNote) =>
    `Analise se faz sentido ${verb} os temas abaixo.\n${reason}\n${semanticNote}`,

  reasonLabels: {
    affinity: (pct) => `afinidade vetorial ${pct}%`,
    neighbors: (k, n) => `${k}/${n} vizinhos neste tema`,
    topics: (topics) => `tópicos: ${topics}`,
    semanticDesc: 'via descrição semântica',
  },

  summaryPromptLabels: {
    titleLabel: 'Título:',
    contentLabel: 'Conteúdo:',
  },

  noteFormatterLabels: {
    summaryLabel: 'Resumo:',
    noSummaryLabel: '(sem resumo)',
    topicsLabel: 'Tópicos:',
    noTopicsLabel: '(sem)',
  },

  splitFallbackInstruction: `Abaixo estão notas de um tema onde a análise vetorial não detectou clusters distintos — as notas são semanticamente diversas.
Analise os títulos, resumos e tópicos para identificar subgrupos conceituais que os vetores não capturaram.
Proponha subtemas apenas quando houver 2+ notas claramente relacionadas formando um subgrupo.
Notas que não pertencem a nenhum subgrupo devem permanecer no tema pai — não force agrupamentos.
Não sugira subtemas redundantes com temas irmãos existentes.`,

  splitJsonInstruction: `Retorne JSON: {"splits": [{"name": "string", "description": "string?", "noteIds": ["string"]}]}
Para clusters que não representam um subassunto claro, omita-os do array.`,
};

const ENGLISH: Prompts = {
  summary: `You are a Zettelkasten-style personal note synthesis assistant.

Given the title and content of a note, write a summary in 2 to 3 short sentences.

Mandatory rules:
- Capture the central idea and most relevant points
- Respond in English
- Plain prose only — no markdown, no lists, no headings, no bullet points
- No introductory phrase ("This note is about...", "Here is a summary...")
- Respond ONLY with the summary sentences, nothing else`,

  classifyBase: `You are an expert in Zettelkasten and Information Architecture (reference: Sönke Ahrens - How to Take Smart Notes).
Each note is presented with its title, an AI-generated summary, and automatically extracted topics — use topics as the primary categorization signal.
Rules: Do not converse, just process. Return ONLY valid JSON, no markdown or extra text.
Do NOT create new themes — use only the listed themes.
Each note may belong to 1, 2, or up to 3 themes. Assign multiple themes only when the note genuinely crosses domains — do not force multi-assignment.
SPECIFICITY PRIORITY: always prefer the most specific subtheme over its parent. If a subtheme covers the subject, assign ONLY to the subtheme — never to both the subtheme and its parent simultaneously. Only assign to a generic/root theme when no existing subtheme fits.`,

  styleInstructions: {
    'single-word': 'Create theme names using a single word.',
    'short-phrase': 'Create theme names using 2-4 words.',
    descriptive: 'Create descriptive and specific theme names (5-10 words).',
  },

  baseThemesHeader:
    'User base themes (treat as anchors — assign notes to them or their subthemes, never ignore them):',
  classifyThemesHeader: 'Existing themes:',
  classifyNotesHeader: 'Notes to categorize (assign each note to 1+ existing themes):',
  classifyHintLabel: 'Previous classifications strongly suggest:',
  classifyNoThemesLabel: '(no themes registered)',
  classifyOtherThemesLabel: 'Other existing themes:',
  classifyJsonSchema: `{
  "assignments": [{"noteId": "string", "themeNames": ["string"]}]
}
The noteId field must be the UUID shown as [ID: ...] in the note. Do not use the note title.`,
  classifyAssignmentsNote:
    '- assignments: for each note, themeNames from existing themes (exact names from the list)\n- Use 1 theme when the note clearly belongs to one area. Use 2+ when it crosses distinct areas.',

  contextLabel: 'User context:',

  splitInstruction: `Below are algorithmically detected note clusters within a theme.
Each cluster is a vector grouping — semantically similar notes.
For each cluster, suggest a subtheme name that captures the common subject.
Do not suggest subthemes redundant with existing sibling themes.
If a cluster does not represent a cohesive subtopic, return it with an empty name to ignore it.`,

  splitDepthCaution: (depth) =>
    depth >= 2
      ? `\nDepth ${depth} — be selective: only propose subthemes with very clear semantic subgroups.`
      : '',

  splitResidualNote: (count) =>
    `(${count} notes remain in the parent theme as they don't belong to any cluster)`,

  splitLabels: {
    topicsLabel: 'Topics:',
    noTopicsLabel: '(none)',
    clusterLabel: (index, count) => `Cluster ${index + 1} (${count} notes):`,
    existingSubthemesLabel: 'Existing subthemes (DO NOT repeat these names):',
    siblingsLabel: 'Existing sibling themes:',
    topFreqTopicsLabel: 'Most frequent topics:',
    overlapLabel: 'Overlap with other themes:',
  },

  multiAssignInstruction: `Analyze multi-assignment candidates: notes with content relevant to more than one theme.
Anchor themes marked with ★ were created by the user — approve when the note has content related to the area, even if it is not the main focus.
For non-★ themes, approve when the note directly addresses the theme's subject.
The semantic model already pre-filtered the most relevant candidates — prefer approving when in doubt.`,

  multiAssignLabels: {
    topicsLabel: 'Topics:',
    noTopicsLabel: '(none)',
    currentThemesLabel: 'Current themes:',
    candidateLabel: 'Candidate theme:',
    jsonInstruction: `Return JSON: {"multiAssignments": [{"noteId": "note-uuid", "themeId": "exact-theme-uuid-or-name"}]}
noteId is the UUID shown as [ID: ...]. themeId can be the UUID or exact theme name. Empty array if none are valid.`,
  },

  organizeBase: `You are an expert in Zettelkasten and Information Architecture (reference: Sönke Ahrens - How to Take Smart Notes).
Rules: Do not converse, just process. Return ONLY valid JSON, no markdown or extra text.`,

  consolidateBase: `You are an expert in Zettelkasten and Information Architecture (reference: Sönke Ahrens - How to Take Smart Notes).
Focus: theme cohesion and granularity. Maintain organizational consistency.
Rules: Do not converse, just process. Return ONLY valid JSON, no markdown or extra text.`,

  rerouteInstruction: `Analyze whether the notes below are better classified under a different theme.
Each note shows its semantic neighbor graph (relatedNotes) and those neighbors' themes.
The link ratio indicates the fraction of neighbors in the suggested theme. Use semantic content to validate.`,

  rerouteLabels: {
    noteLabel: 'Note',
    summaryLabel: 'Summary:',
    noSummaryLabel: '(no summary)',
    topicsLabel: 'Topics:',
    noTopicsLabel: '(none)',
    currentThemeLabel: 'Current theme',
    suggestedThemeLabel: 'Suggested theme',
    neighborsLabel: 'Semantic neighbors:',
    noNeighborsLabel: '(no neighbors)',
    noThemeLabel: '(no theme)',
    relatedThemePrefix: 'theme:',
    affinityLabel: 'affinity:',
    marginLabel: 'Margin:',
    candidatesLabel: 'Candidates:',
    jsonInstruction: `Return JSON: {"redistributions": [{"noteId": "string", "fromThemeId": "string", "toThemeId": "string"}]}
Include only notes that should genuinely move. Empty array if none.`,
  },

  affinityInstruction: `Analyze whether the notes below are better classified under a different theme.
The affinity margin indicates how much closer the candidate theme is vectorially than the current one.
Use semantic content (title, summary, topics) for the final decision — vector affinity is a signal, not a truth.`,

  affinityLabels: {
    noteLabel: 'Note',
    summaryLabel: 'Summary:',
    noSummaryLabel: '(no summary)',
    topicsLabel: 'Topics:',
    noTopicsLabel: '(none)',
    currentThemeLabel: 'Current theme',
    suggestedThemeLabel: 'Suggested theme',
    neighborsLabel: 'Semantic neighbors:',
    noNeighborsLabel: '(no neighbors)',
    noThemeLabel: '(no theme)',
    relatedThemePrefix: 'theme:',
    affinityLabel: 'affinity:',
    marginLabel: 'Margin:',
    candidatesLabel: 'Candidates:',
    jsonInstruction: `Return JSON: {"redistributions": [{"noteId": "string", "fromThemeId": "string", "toThemeId": "string"}]}
Include only notes that should genuinely move. Empty array if none.`,
  },

  connectionsAddVerb: 'connect',
  connectionsRemoveVerb: 'disconnect',
  connectionsHighReason: 'High note co-occurrence indicates these themes are related.',
  connectionsLowReason: 'Low co-occurrence indicates the connection no longer reflects reality.',
  connectionsSemanticNote: 'Use semantic context for the final decision.',

  connectionLabels: {
    themeLabel: 'Theme:',
    currentParentsLabel: 'Current parents:',
    rootLabel: '(root)',
    proposedLabel: 'Proposed connection:',
    disconnectLabel: 'Proposed disconnection:',
    cooccurrenceLabel: 'co-occurrence:',
    notesSuffix: 'notes',
  },

  connectionsJsonNote: (field) =>
    `Return JSON: {"${field}": [{"themeId": "string", "parentId": "string"}]}\nInclude only connections that make sense. Empty array if none.`,

  connectionsAnalyzeInstruction: (verb, reason, semanticNote) =>
    `Analyze whether it makes sense to ${verb} the themes below.\n${reason}\n${semanticNote}`,

  reasonLabels: {
    affinity: (pct) => `vector affinity ${pct}%`,
    neighbors: (k, n) => `${k}/${n} neighbors in this theme`,
    topics: (topics) => `topics: ${topics}`,
    semanticDesc: 'via semantic description',
  },

  summaryPromptLabels: {
    titleLabel: 'Title:',
    contentLabel: 'Content:',
  },

  noteFormatterLabels: {
    summaryLabel: 'Summary:',
    noSummaryLabel: '(no summary)',
    topicsLabel: 'Topics:',
    noTopicsLabel: '(none)',
  },

  splitFallbackInstruction: `Below are notes from a theme where vector analysis detected no distinct clusters — the notes are semantically diverse.
Analyze titles, summaries, and topics to identify conceptual subgroups that vectors did not capture.
Propose subthemes only when 2+ notes are clearly related and form a subgroup.
Notes that do not belong to any subgroup should remain in the parent theme — do not force groupings.
Do not suggest subthemes redundant with existing sibling themes.`,

  splitJsonInstruction: `Return JSON: {"splits": [{"name": "string", "description": "string?", "noteIds": ["string"]}]}
For clusters that do not represent a clear subtopic, omit them from the array.`,
};

const PROMPTS: Record<Language, Prompts> = {
  portuguese: PORTUGUESE,
  english: ENGLISH,
};

export function getPrompts(lang: Language): Prompts {
  return PROMPTS[lang];
}
