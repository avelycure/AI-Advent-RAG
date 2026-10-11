export interface ModelParameters {
  temperature: number;
  repeat_penalty: number;
  num_predict: number;
  num_ctx: number;
}

export const MODEL_PARAMETER_SLIDERS = [
  { key: 'temperature', label: 'Температура', hint: 'Меньше — точнее, больше — свободнее', min: 0, max: 1, step: 0.05, initial: 0.1 },
  { key: 'repeat_penalty', label: 'Штраф за повторы', hint: '1 — сохранять повторы исходного текста', min: 0.8, max: 1.5, step: 0.05, initial: 1 },
  { key: 'num_predict', label: 'Длина ответа', hint: 'Максимум токенов в ответе', min: 1024, max: 16384, step: 1024, initial: 8192 },
  { key: 'num_ctx', label: 'Размер контекста', hint: 'Токены для текста и ответа', min: 8192, max: 65536, step: 8192, initial: 32768 },
] as const;

export function sanitizeModelParameters(value: unknown): ModelParameters {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result = {} as ModelParameters;
  for (const slider of MODEL_PARAMETER_SLIDERS) {
    const raw = record[slider.key];
    const number = typeof raw === 'number' && Number.isFinite(raw) ? raw : slider.initial;
    const bounded = Math.max(slider.min, Math.min(slider.max, number));
    result[slider.key] = Number((slider.min + Math.round((bounded - slider.min) / slider.step) * slider.step).toFixed(2));
  }
  // Keep room for the input when the output limit is increased or context is reduced.
  result.num_predict = Math.min(result.num_predict, result.num_ctx / 2);
  return result;
}
