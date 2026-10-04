import {
  Notice,
  PluginSettingTab,
  Setting,
  type App,
  type ButtonComponent,
  type SliderComponent,
} from 'obsidian';
import type AiAdventRagPlugin from '../main';
import {
  MAX_RETRIEVAL_CANDIDATE_TOP_K,
  MAX_RETRIEVAL_FINAL_TOP_K,
  MIN_RETRIEVAL_CANDIDATE_TOP_K,
  MIN_RETRIEVAL_FINAL_TOP_K,
  isValidFolderPath,
  normalizeFolder,
} from './defaults';
import {
  MAX_FIXED_CHUNK_SIZE,
  MIN_FIXED_CHUNK_SIZE,
  type ChunkingMetrics,
  type ChunkingStrategy,
  type FolderMode,
  type IndexStorageFormat,
  type StructureChunkingUnit,
} from '../types';

export class AiAdventRagSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: AiAdventRagPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    let indexStatusDescription: HTMLElement | null = null;
    const refreshIndexStatus = (): void => {
      indexStatusDescription?.setText(this.plugin.indexSummary());
    };
    new Setting(containerEl).setName('Индекс').setHeading();

    new Setting(containerEl).setName('Локальные эмбеддинги').setDesc(
      'Для индекса и поиска используется qwen3-embedding:0.6b через локальную Ollama. В режиме RAG найденные фрагменты отправляются в DeepSeek только при отправке вопроса.',
    );

    let finalTopKSlider: SliderComponent | undefined;
    new Setting(containerEl)
      .setName('Формат хранения индекса')
      .setDesc(
        'Все варианты хранят полный незашифрованный текст чанков локально в папке rag-indexes. JSON удобно просматривать, SQLite — исследовать запросами, а FAISS выполняет поиск по векторам и хранит тексты с метаданными в соседнем JSON-файле. Старые форматы остаются на диске для восстановления; удалить их можно вручную из папки rag-indexes.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('binary', 'Бинарный файл — рекомендуется')
          .addOption('json', 'JSON — для просмотра')
          .addOption('sqlite', 'SQLite — структурированная база')
          .addOption('faiss', 'FAISS — векторный индекс')
          .setValue(this.plugin.settings.indexStorageFormat)
          .onChange(async (value) => {
            this.plugin.settings.indexStorageFormat = value as IndexStorageFormat;
            this.plugin.markIndexDirty();
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (
      this.plugin.settings.indexStorageFormat !==
      this.plugin.settings.activeIndexStorageFormat
    ) {
      new Setting(containerEl)
        .setName('Формат ожидает применения')
        .setDesc(
          'Текущий индекс продолжает работать. Новый формат станет активным только после успешного перестроения.',
        );
    }

    new Setting(containerEl)
      .setName('Способ разбиения на чанки')
      .setDesc(
        'Фиксированный размер создаёт перекрывающиеся окна. Разбиение по структуре сохраняет границы разделов Markdown.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('fixed-size', 'Фиксированный размер')
          .addOption('structure-aware', 'По структуре Markdown')
          .setValue(this.plugin.settings.chunkingStrategy)
          .onChange(async (value) => {
            this.plugin.settings.chunkingStrategy = value as ChunkingStrategy;
            this.plugin.markIndexDirty();
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.chunkingStrategy === 'structure-aware') {
      new Setting(containerEl)
        .setName('Единица структурного разбиения')
        .setDesc(
          'Абзацы создают отдельный чанк для каждого текстового блока. Разделы используют границы заголовков Markdown. Файлы сохраняют каждую заметку одним чанком. Структурные чанки не обрезаются: если чанк превышает контекст qwen, перестроение завершится ошибкой.',
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOption('paragraph', 'Абзацы')
            .addOption('section', 'Разделы')
            .addOption('file', 'Файлы')
            .setValue(this.plugin.settings.structureChunkingUnit)
            .onChange(async (value) => {
              this.plugin.settings.structureChunkingUnit = value as StructureChunkingUnit;
              this.plugin.markIndexDirty();
              await this.plugin.saveSettings();
              refreshIndexStatus();
            }),
        );
    } else {
      const sizeSetting = new Setting(containerEl)
        .setName('Размер чанка')
        .setDesc(
          `Максимальное количество символов в чанке: от ${MIN_FIXED_CHUNK_SIZE.toLocaleString('ru-RU')} до ${MAX_FIXED_CHUNK_SIZE.toLocaleString('ru-RU')}. Перекрытие рассчитывается автоматически.`,
        );
      const validationId = 'ai-advent-rag-fixed-chunk-size-error';
      const validationMessage = sizeSetting.descEl.createDiv({
        cls: 'ai-advent-rag-validation-message',
        attr: { id: validationId, role: 'alert', 'aria-live': 'polite' },
      });
      sizeSetting.addText((text) => {
          text.inputEl.type = 'number';
          text.inputEl.min = String(MIN_FIXED_CHUNK_SIZE);
          text.inputEl.max = String(MAX_FIXED_CHUNK_SIZE);
          text.inputEl.step = '1';
          text.inputEl.setAttribute('aria-describedby', validationId);
          const clearValidation = (): void => {
            validationMessage.empty();
            text.inputEl.removeAttribute('aria-invalid');
            text.inputEl.setCustomValidity('');
          };
          const showValidation = (): void => {
            const message = `Введите целое число от ${MIN_FIXED_CHUNK_SIZE.toLocaleString('ru-RU')} до ${MAX_FIXED_CHUNK_SIZE.toLocaleString('ru-RU')}.`;
            validationMessage.setText(message);
            text.inputEl.setAttribute('aria-invalid', 'true');
            text.inputEl.setCustomValidity(message);
          };
          text
            .setValue(String(this.plugin.settings.fixedChunkSize))
            .onChange(async (value) => {
              const parsed = Number(value);
              if (
                !Number.isInteger(parsed) ||
                parsed < MIN_FIXED_CHUNK_SIZE ||
                parsed > MAX_FIXED_CHUNK_SIZE
              ) {
                showValidation();
                return;
              }
              clearValidation();
              if (parsed === this.plugin.settings.fixedChunkSize) return;
              this.plugin.settings.fixedChunkSize = parsed;
              this.plugin.markIndexDirty();
              await this.plugin.saveSettings();
              refreshIndexStatus();
            });
          text.inputEl.addEventListener('blur', () => {
            if (text.inputEl.getAttribute('aria-invalid') !== 'true') return;
            text.setValue(String(this.plugin.settings.fixedChunkSize));
            clearValidation();
          });
        });
    }

    const indexStatusSetting = new Setting(containerEl)
      .setName('Состояние индекса')
      .setDesc(this.plugin.indexSummary());
    indexStatusDescription = indexStatusSetting.descEl;
    indexStatusDescription.setAttribute('role', 'status');
    indexStatusDescription.setAttribute('aria-live', 'polite');
    indexStatusDescription.setAttribute('aria-atomic', 'true');
    indexStatusSetting.addButton((button) =>
        button
          .setButtonText(
            this.plugin.settings.indexStorageFormat ===
              this.plugin.settings.activeIndexStorageFormat
              ? 'Перестроить индекс'
              : 'Применить и перестроить индекс',
          )
          .setCta()
          .setDisabled(this.plugin.isIndexRebuilding())
          .onClick(async () => {
            button.setDisabled(true).setButtonText('Идёт перестроение…');
            try {
              await this.plugin.rebuildIndexWithNotices();
            } finally {
              this.display();
            }
          }),
      );

    this.renderChunkingComparison(containerEl);

    new Setting(containerEl).setName('Что индексировать').setHeading();
    new Setting(containerEl)
      .setName('Выбор папок')
      .setDesc('Можно индексировать все папки, только выбранные или все, кроме выбранных.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('all', 'Все папки')
          .addOption('include', 'Только выбранные папки')
          .addOption('exclude', 'Все, кроме выбранных')
          .setValue(this.plugin.settings.folderMode)
          .onChange(async (value) => {
            this.plugin.settings.folderMode = value as FolderMode;
            this.plugin.markIndexDirty();
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.folderMode !== 'all') this.renderFolderSelection(containerEl);

    new Setting(containerEl).setName('Чат с DeepSeek').setHeading();
    new Setting(containerEl)
      .setName('Использовать RAG')
      .setDesc(
        this.plugin.settings.useRag
          ? 'Вопрос сначала ищется в локальном индексе. Затем вопрос и показанные в чате фрагменты заметок отправляются в DeepSeek.'
          : 'В DeepSeek отправляются только вопрос и недавняя история текущего чата. Индекс и заметки не используются.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useRag)
          .onChange(async (value) => {
            this.plugin.settings.useRag = value;
            await this.plugin.saveSettings();
            this.plugin.refreshChatViews();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Модель DeepSeek')
      .setDesc('По умолчанию используется экономичная модель deepseek-flash в режиме без рассуждений.')
      .addText((text) =>
        text
          .setPlaceholder('deepseek-flash')
          .setValue(this.plugin.settings.llmModel)
          .onChange(async (value) => {
            const model = value.trim();
            if (!model) return;
            this.plugin.settings.llmModel = model;
            await this.plugin.saveSettings();
          }),
      );

    let tokenDraft = '';
    let saveTokenButton: ButtonComponent;
    const tokenSetting = new Setting(containerEl)
      .setName('API-ключ DeepSeek')
      .setDesc(
        'Ключ хранится локально в SecretStorage Obsidian и не записывается в data.json. Используется официальный DeepSeek Chat Completions API.',
      );
    tokenSetting
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.setPlaceholder(
          this.plugin.hasDeepSeekApiKey() ? 'Ключ сохранён локально' : 'Вставьте ключ DeepSeek API',
        );
        text.onChange((value) => {
          tokenDraft = value;
          saveTokenButton?.setDisabled(!value.trim());
        });
      })
      .addButton((button) => {
        saveTokenButton = button;
        button
          .setButtonText('Сохранить токен')
          .setCta()
          .setDisabled(true)
          .onClick(async () => {
            try {
              await this.plugin.saveDeepSeekApiKey(tokenDraft);
              new Notice('API-ключ DeepSeek сохранён локально.');
              this.display();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error));
            }
          });
      })
      .addButton((button) =>
        button
          .setButtonText('Удалить токен')
          .setWarning()
          .setDisabled(!this.plugin.hasDeepSeekApiKey())
          .onClick(async () => {
            await this.plugin.clearDeepSeekApiKey();
            new Notice('API-ключ DeepSeek удалён.');
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Проверка DeepSeek')
      .setDesc('Проверяет доступ к выбранной модели через официальный DeepSeek API без текста заметок.')
      .addButton((button) =>
        button
          .setButtonText('Проверить подключение')
          .setDisabled(!this.plugin.hasDeepSeekApiKey())
          .onClick(async () => {
            button.setDisabled(true).setButtonText('Проверка…');
            try {
              await this.plugin.testDeepSeekConnection();
              new Notice('DeepSeek API доступен, выбранная модель отвечает.');
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error));
            } finally {
              this.display();
            }
          }),
      );

    new Setting(containerEl).setName('Улучшение поиска для RAG').setHeading();
    new Setting(containerEl)
      .setName('Фильтрация и переформулирование запроса')
      .setDesc(
        this.plugin.settings.useRetrievalEnhancements
          ? 'DeepSeek превращает вопрос в самостоятельный поисковый запрос, затем similarity-порог отбрасывает слабые совпадения. Для ответа выполняется отдельный запрос к DeepSeek.'
          : 'Используется исходный вопрос и базовый векторный поиск без порога релевантности. Этот режим нужен для сравнения качества.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useRetrievalEnhancements)
          .onChange(async (value) => {
            this.plugin.settings.useRetrievalEnhancements = value;
            await this.plugin.saveSettings();
            this.plugin.refreshChatViews();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Количество кандидатов до фильтрации (top-K)')
      .setDesc('Сколько наиболее близких чанков получить из локального векторного индекса до применения порога.')
      .addSlider((slider) =>
        slider
          .setLimits(
            MIN_RETRIEVAL_CANDIDATE_TOP_K,
            MAX_RETRIEVAL_CANDIDATE_TOP_K,
            1,
          )
          .setValue(this.plugin.settings.retrievalCandidateTopK)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.retrievalCandidateTopK = value;
            this.plugin.settings.retrievalFinalTopK = Math.min(
              value,
              this.plugin.settings.retrievalFinalTopK,
            );
            await this.plugin.saveSettings();
            finalTopKSlider
              ?.setLimits(
                MIN_RETRIEVAL_FINAL_TOP_K,
                Math.min(MAX_RETRIEVAL_FINAL_TOP_K, value),
                1,
              )
              .setValue(this.plugin.settings.retrievalFinalTopK);
          }),
      );

    new Setting(containerEl)
      .setName('Порог сходства (similarity)')
      .setDesc(
        `Файл проходит фильтр, если similarity его лучшего чанка не ниже порога; затем реранкер выбирает содержательные чанки этого файла. Текущее значение: ${this.plugin.settings.similarityThreshold.toFixed(2)}. Значение 0 отключает абсолютное отсечение.`,
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.01)
          .setValue(this.plugin.settings.similarityThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.similarityThreshold = Math.round(value * 100) / 100;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Количество результатов после фильтрации (top-K)')
      .setDesc('Максимальное количество прошедших порог чанков, которые можно отправить в DeepSeek.')
      .addSlider((slider) =>
        (finalTopKSlider = slider)
          .setLimits(
            MIN_RETRIEVAL_FINAL_TOP_K,
            Math.min(
              MAX_RETRIEVAL_FINAL_TOP_K,
              this.plugin.settings.retrievalCandidateTopK,
            ),
            1,
          )
          .setValue(this.plugin.settings.retrievalFinalTopK)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.retrievalFinalTopK = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderChunkingComparison(containerEl: HTMLElement): void {
    const comparison = this.plugin.chunkingComparison();
    if (!comparison) return;
    new Setting(containerEl).setName('Сравнение стратегий разбиения').setHeading();
    new Setting(containerEl)
      .setName('Индексируемый корпус')
      .setDesc(
        `${comparison.documentCount} документов · ${comparison.sourceCharacters.toLocaleString('ru-RU')} символов · примерно ${comparison.estimatedPages} страниц.`,
      );
    this.renderStrategyMetrics(containerEl, 'Фиксированный размер', comparison.fixedSize);
    this.renderStrategyMetrics(
      containerEl,
      `По структуре: ${structureChunkingUnitLabel(comparison.structureChunkingUnit)}`,
      comparison.structureAware,
    );
  }

  private renderStrategyMetrics(
    containerEl: HTMLElement,
    name: string,
    metrics: ChunkingMetrics,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(
        `${metrics.chunkCount} чанков · средний размер ${metrics.averageCharacters} символов · p95 ${metrics.p95Characters} · раздел указан у ${metrics.sectionMetadataPercent}%.`,
      );
  }

  private renderFolderSelection(containerEl: HTMLElement): void {
    const description = containerEl.createDiv({ cls: 'setting-item-description' });
    description.setText(
      this.plugin.settings.folderMode === 'include'
        ? 'Будут индексироваться только заметки в отмеченных папках и их подпапках.'
        : 'Заметки в отмеченных папках и их подпапках будут исключены из индекса.',
    );
    let pendingFolder = '';
    let addButton: ButtonComponent;
    const addFolderSetting = new Setting(containerEl)
      .setName('Добавить папку')
      .setDesc('Введите путь относительно корня хранилища, например «Проекты/2026».');
    const validationId = 'ai-advent-rag-folder-path-error';
    const validationMessage = addFolderSetting.descEl.createDiv({
      cls: 'ai-advent-rag-validation-message',
      attr: { id: validationId, role: 'alert', 'aria-live': 'polite' },
    });
    addFolderSetting
      .addText((text) => {
        text.inputEl.setAttribute('aria-describedby', validationId);
        text.setPlaceholder('Папка или Папка/Подпапка').onChange((value) => {
          pendingFolder = value;
          const normalized = normalizeFolder(value);
          const alreadySelected = this.plugin.settings.selectedFolders.includes(normalized);
          const valid = isValidFolderPath(normalized);
          addButton?.setDisabled(!valid || alreadySelected);
          validationMessage.empty();
          text.inputEl.removeAttribute('aria-invalid');
          if (value && !valid) {
            validationMessage.setText('Путь к папке не должен содержать сегменты «.» или «..».');
            text.inputEl.setAttribute('aria-invalid', 'true');
          } else if (alreadySelected) {
            validationMessage.setText('Эта папка уже добавлена.');
            text.inputEl.setAttribute('aria-invalid', 'true');
          }
        });
        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || addButton.buttonEl.disabled) return;
          event.preventDefault();
          addButton.buttonEl.click();
        });
      })
      .addButton((button) => {
        addButton = button;
        button
          .setButtonText('Добавить')
          .setDisabled(true)
          .onClick(async () => {
            const folder = normalizeFolder(pendingFolder);
            if (
              !isValidFolderPath(folder) ||
              this.plugin.settings.selectedFolders.includes(folder)
            ) {
              return;
            }
            this.plugin.settings.selectedFolders = [
              ...this.plugin.settings.selectedFolders,
              folder,
            ].sort((left, right) => left.localeCompare(right));
            this.plugin.markIndexDirty();
            await this.plugin.saveSettings();
            this.display();
          });
      });
    const list = containerEl.createDiv({ cls: 'ai-advent-rag-folder-list' });
    const folders = [...new Set([
      ...this.plugin.availableFolders(),
      ...this.plugin.settings.selectedFolders,
    ])].sort((left, right) => left.localeCompare(right));
    if (folders.length === 0) {
      list.createDiv({ text: 'Папки не найдены. Добавьте путь вручную выше.' });
      return;
    }
    for (const folder of folders) {
      new Setting(list).setName(folder).addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.selectedFolders.includes(folder))
          .onChange(async (selected) => {
            const folders = new Set(this.plugin.settings.selectedFolders);
            if (selected) folders.add(folder);
            else folders.delete(folder);
            this.plugin.settings.selectedFolders = [...folders].sort((a, b) => a.localeCompare(b));
            this.plugin.markIndexDirty();
            await this.plugin.saveSettings();
          }),
      );
    }
  }
}

function structureChunkingUnitLabel(unit: StructureChunkingUnit): string {
  switch (unit) {
    case 'paragraph':
      return 'абзацы';
    case 'section':
      return 'разделы';
    case 'file':
      return 'файлы';
  }
}
