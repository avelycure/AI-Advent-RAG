import { PluginSettingTab, Setting, type App, type ButtonComponent } from 'obsidian';
import type AiAdventRagPlugin from '../main';
import { isValidFolderPath, normalizeFolder } from './defaults';
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
      'Для индекса и поиска используется qwen3-embedding:0.6b через локальную Ollama. Тексты заметок не отправляются в LLM.',
    );

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

    new Setting(containerEl).setName('Поиск').setHeading();
    new Setting(containerEl)
      .setName('Максимум результатов')
      .setDesc('Максимальное количество найденных фрагментов в панели поиска.')
      .addSlider((slider) =>
        slider
          .setLimits(3, 20, 1)
          .setValue(this.plugin.settings.topK)
          .onChange(async (value) => {
            this.plugin.settings.topK = value;
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
