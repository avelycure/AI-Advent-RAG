import type { ChatEntry } from './chat-state';

export function analyticsRows(entries: readonly ChatEntry[]): Array<[string, string]> {
  const measured = entries.flatMap((entry) => entry.analytics ? [entry.analytics] : []);
  const last = measured.at(-1);
  if (!last) return [];
  const sum = (key: 'inputTokens' | 'outputTokens' | 'generationMs' | 'loadMs' | 'promptMs'): number | undefined => {
    if (!last.calls.length || last.calls.some((call) => call[key] === undefined)) return undefined;
    return last.calls.reduce((total, call) => total + call[key]!, 0);
  };
  const seconds = (value: number | undefined): string => value === undefined ? 'Нет данных' : `${(value / 1000).toFixed(2)} с`;
  const tokens = (value: number | undefined): string => value === undefined ? 'Нет данных' : value.toLocaleString('ru-RU');
  const input = sum('inputTokens'), output = sum('outputTokens'), generation = sum('generationMs');
  const answerCall = last.calls.at(-1);
  const gb = (value: number | undefined): string => value === undefined ? 'Нет данных' : `${(value / 1024 ** 3).toFixed(2)} ГиБ`;
  return [
    ['Измерено ответов в диалоге', String(measured.length)],
    ['Модель', answerCall?.model ?? 'Нет данных'],
    ['Последний запрос · вызовы Qwen', String(last.calls.length)],
    ['Обработка запроса', seconds(last.elapsedMs)], ['Ожидание в очереди', seconds(last.queueMs)],
    ['Первый токен финального ответа', seconds(answerCall?.firstTokenMs)],
    ['Токены вход / выход', `${tokens(input)} / ${tokens(output)}`],
    ['Скорость генерации', output !== undefined && generation !== undefined && generation > 0 ? `${(output * 1000 / generation).toFixed(1)} ток/с` : 'Нет данных'],
    ['Загрузка модели', seconds(sum('loadMs'))], ['Обработка промптов', seconds(sum('promptMs'))],
    ['Генерация', seconds(generation)], ['Память модели после ответа', gb(answerCall?.memoryBytes)],
    ['Из неё GPU / Metal', gb(answerCall?.vramBytes)],
    ['Всего токенов диалога · вход / выход', `${tokens(measured.every((item) => item.calls.length && item.calls.every((call) => call.inputTokens !== undefined)) ? measured.reduce((n, item) => n + item.calls.reduce((v, call) => v + call.inputTokens!, 0), 0) : undefined)} / ${tokens(measured.every((item) => item.calls.length && item.calls.every((call) => call.outputTokens !== undefined)) ? measured.reduce((n, item) => n + item.calls.reduce((v, call) => v + call.outputTokens!, 0), 0) : undefined)}`],
  ];
}
