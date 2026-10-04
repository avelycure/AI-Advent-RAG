import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface EvaluationCase {
  id: string;
  question: string;
  must_include: string[];
  expected_sources: string[];
  expected_sections: string[];
  abstain: boolean;
}

interface EvaluationSet {
  version: number;
  cases: EvaluationCase[];
}

describe('Day 22 evaluation set', () => {
  const evaluation = JSON.parse(
    readFileSync(new URL('../eval/day22-control-questions.json', import.meta.url), 'utf8'),
  ) as EvaluationSet;

  it('contains ten uniquely identified control questions', () => {
    expect(evaluation.version).toBe(1);
    expect(evaluation.cases).toHaveLength(10);
    expect(new Set(evaluation.cases.map((item) => item.id)).size).toBe(10);
    expect(evaluation.cases.every((item) => item.question.trim() && item.must_include.length > 0)).toBe(
      true,
    );
  });

  it('contains one negative question with no expected source', () => {
    const negative = evaluation.cases.filter((item) => item.abstain);
    expect(negative).toHaveLength(1);
    expect(negative[0]?.expected_sources).toEqual([]);
    expect(negative[0]?.expected_sections).toEqual([]);
    expect(evaluation.cases.filter((item) => !item.abstain).every((item) => item.expected_sources.length > 0)).toBe(
      true,
    );
  });
});

describe('Day 23 evaluation set', () => {
  const evaluation = JSON.parse(
    readFileSync(new URL('../eval/day23-control-questions.json', import.meta.url), 'utf8'),
  ) as Day23EvaluationSet;

  it('contains ten contextual questions for query rewriting', () => {
    expect(evaluation.version).toBe(1);
    expect(evaluation.cases).toHaveLength(10);
    expect(new Set(evaluation.cases.map((item) => item.id)).size).toBe(10);
    expect(evaluation.cases.every((item) => item.history.length > 0)).toBe(true);
  });

  it('keeps one negative control without an expected source', () => {
    const negative = evaluation.cases.filter((item) => item.abstain);
    expect(negative).toHaveLength(1);
    expect(negative[0]?.expected_sources).toEqual([]);
  });
});

interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

interface Day23EvaluationSet {
  version: number;
  cases: Array<{
    id: string;
    history: ChatHistoryEntry[];
    question: string;
    must_include: string[];
    expected_sources: string[];
    abstain: boolean;
  }>;
}

describe('Day 24 evaluation set', () => {
  const evaluation = JSON.parse(
    readFileSync(new URL('../eval/day24-control-questions.json', import.meta.url), 'utf8'),
  ) as Day24EvaluationSet;

  it('contains ten answerable grounding controls with expected sources', () => {
    expect(evaluation.version).toBe(1);
    expect(evaluation.cases).toHaveLength(10);
    expect(new Set(evaluation.cases.map((item) => item.id)).size).toBe(10);
    expect(evaluation.cases.every((item) =>
      item.history.length > 0 && item.must_include.length > 0 && item.expected_sources.length > 0,
    )).toBe(true);
  });

  it('keeps weak context as a separate “не знаю” control', () => {
    expect(evaluation.weak_context_case.expected_sources).toEqual([]);
    expect(evaluation.weak_context_case.expected_response_contains).toContain('не знаю');
    expect(evaluation.weak_context_case.expected_response_contains).toContain('уточните');
  });
});

interface Day24EvaluationSet {
  version: number;
  cases: Array<{
    id: string;
    history: ChatHistoryEntry[];
    question: string;
    must_include: string[];
    expected_sources: string[];
  }>;
  weak_context_case: {
    id: string;
    history: ChatHistoryEntry[];
    question: string;
    expected_response_contains: string[];
    expected_sources: string[];
  };
}
