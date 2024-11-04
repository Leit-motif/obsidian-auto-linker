import {
    App,
    MarkdownView,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
} from 'obsidian';

// Define the settings interface
interface AutoLinkerSettings {
    existingFilesOnly: boolean;
    specifiedDirectory: string;
    excludedBlocks: string;
    blacklistedStrings: string;
    whitelistedStrings: string;
    linksToRemove: string;
    debugMode: boolean;
}

// Default settings
const DEFAULT_SETTINGS: AutoLinkerSettings = {
    existingFilesOnly: false,
    specifiedDirectory: '',
    excludedBlocks: '',
    blacklistedStrings: '',
    whitelistedStrings: '',
    linksToRemove: '',
    debugMode: false,
};

// Main plugin class
export default class AutoLinkerPlugin extends Plugin {
    settings: AutoLinkerSettings;
    private lastChanges: { file: TFile; oldContent: string }[] = [];

    async onload() {
        await this.loadSettings();

        // Add ribbon icon
        this.addRibbonIcon('link', 'Auto Link Current File', () => {
            this.autoLinkCurrentFile();
        });

        // Add command
        this.addCommand({
            id: 'auto-link-current-file',
            name: 'Auto-link current file',
            checkCallback: (checking: boolean) => {
                const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (activeView) {
                    if (!checking) {
                        this.autoLinkCurrentFile();
                    }
                    return true;
                }
                return false;
            },
        });

        // Add settings tab
        this.addSettingTab(new AutoLinkerSettingTab(this.app, this));
    }

    onunload() {
        // Cleanup if necessary
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Auto-links the current active file.
     */
    async autoLinkCurrentFile() {
        this.lastChanges = []; // Clear previous changes
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView && activeView.file) {
            await this.autoLinkFile(activeView.file);
            new Notice(`Auto-linking completed for ${activeView.file.basename}`);
        } else {
            new Notice('No active Markdown file to auto-link');
        }
    }

    /**
     * Auto-links words in a given file.
     * @param file - The file to auto-link.
     */
    public async autoLinkFile(file: TFile) {
        try {
            const content = await this.app.vault.read(file);
            const wordsToLink = await this.getWordsToLink();
            const linkedContent = this.linkWords(content, wordsToLink);

            if (content !== linkedContent) {
                this.lastChanges.push({ file, oldContent: content });
                await this.app.vault.modify(file, linkedContent);
            } else if (this.settings.debugMode) {
                console.log('No changes made to the file');
            }
        } catch (error) {
            new Notice(`Failed to auto-link file: ${file.path}`);
            console.error(error);
        }
    }

    /**
     * Links words in the content based on settings.
     * @param content - The content to process.
     * @param wordsToLink - The words to link.
     * @returns The processed content with links.
     */
    private linkWords(content: string, wordsToLink: string[]): string {
        if (this.settings.debugMode) {
            console.log('Linking words in content');
        }

        const excludedBlocks = this.settings.excludedBlocks
            .split(',')
            .map((block) => block.trim().toLowerCase())
            .filter(Boolean);
        const blacklistedStrings = this.settings.blacklistedStrings
            .split(',')
            .map((str) => str.trim().toLowerCase())
            .filter(Boolean);
        const whitelistedStrings = this.settings.whitelistedStrings
            .split(',')
            .map((str) => str.trim().toLowerCase())
            .filter(Boolean);

        const sections = content.split(/^(#.*$)/m);
        let isExcludedBlock = false;

        for (let i = 0; i < sections.length; i++) {
            if (sections[i].startsWith('#')) {
                isExcludedBlock = excludedBlocks.some((block) =>
                    sections[i].toLowerCase().includes(block)
                );
            } else if (!isExcludedBlock) {
                for (const word of wordsToLink) {
                    const lowercaseWord = word.toLowerCase();
                    if (
                        !blacklistedStrings.includes(lowercaseWord) &&
                        (whitelistedStrings.length === 0 ||
                            whitelistedStrings.includes(lowercaseWord))
                    ) {
                        const pattern = new RegExp(
                            `(?<!\\[\\[)\\b(${this.escapeRegExp(word)})\\b(?!\\]\\])`,
                            'gi'
                        );
                        sections[i] = sections[i].replace(pattern, (match) => {
                            if (this.settings.existingFilesOnly && !this.fileExists(match)) {
                                return match;
                            }
                            return `[[${match}]]`;
                        });
                    }
                }
            }
        }

        return sections.join('');
    }

    /**
     * Retrieves all words that should be linked.
     * @returns An array of words to link.
     */
    private async getWordsToLink(): Promise<string[]> {
        const vaultLinks = await this.getVaultLinks();
        let words = [...new Set(vaultLinks)];

        // Apply whitelist
        const whitelist = this.settings.whitelistedStrings
            .split(',')
            .map((str) => str.trim().toLowerCase())
            .filter(Boolean);

        if (whitelist.length > 0) {
            words = words.filter((word) => whitelist.includes(word.toLowerCase()));
        }

        return words;
    }

    /**
     * Retrieves all links in the vault.
     * @returns An array of links from the vault.
     */
    private async getVaultLinks(): Promise<string[]> {
        const links = new Set<string>();
        const rootFolder = this.app.vault.getRoot();
        await this.processFolder(rootFolder, links);

        return Array.from(links);
    }

    /**
     * Checks if a file exists in the vault.
     * @param link - The link to check.
     * @returns True if the file exists, false otherwise.
     */
    private fileExists(link: string): boolean {
        const linkWithoutExtension = link.replace(/\.md$/, '');
        return this.app.vault.getAbstractFileByPath(`${linkWithoutExtension}.md`) instanceof TFile;
    }

    /**
     * Recursively processes a folder to collect links.
     * @param folder - The folder to process.
     * @param links - A set to store the links.
     */
    private async processFolder(folder: TFolder, links: Set<string>): Promise<void> {
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                const fileLinks = await this.getFileLinks(child);
                fileLinks.forEach((link) => links.add(link));
            } else if (child instanceof TFolder) {
                await this.processFolder(child, links);
            }
        }
    }

    /**
     * Retrieves all links from a file.
     * @param file - The file to process.
     * @returns An array of links from the file.
     */
    private async getFileLinks(file: TFile): Promise<string[]> {
        const content = await this.app.vault.read(file);
        const linkRegex = /\[\[([^\]]+)\]\]/g;
        const links: string[] = [];
        let match: RegExpExecArray | null;

        while ((match = linkRegex.exec(content)) !== null) {
            const link = match[1].split('|')[0].trim();
            if (!link.includes('.') || link.endsWith('.md')) {
                links.push(link);
            }
        }
        return links;
    }

    /**
     * Escapes special characters in a string for use in a regular expression.
     * @param string - The string to escape.
     * @returns The escaped string.
     */
    private escapeRegExp(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Extends linking to a specified directory.
     */
    public async extendLinkingToDirectory() {
        const directory = this.app.vault.getAbstractFileByPath(this.settings.specifiedDirectory);
        if (!(directory instanceof TFolder)) {
            new Notice('Invalid directory specified');
            return;
        }

        const files = await this.getMarkdownFiles(directory);
        for (const file of files) {
            await this.autoLinkFile(file);
        }
        new Notice(
            `Linking extended to ${files.length} files in ${this.settings.specifiedDirectory}`
        );
    }

    /**
     * Retrieves all markdown files in a folder.
     * @param folder - The folder to process.
     * @returns An array of markdown files.
     */
    private async getMarkdownFiles(folder: TFolder): Promise<TFile[]> {
        const files: TFile[] = [];
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                files.push(child);
            } else if (child instanceof TFolder) {
                files.push(...(await this.getMarkdownFiles(child)));
            }
        }
        return files;
    }

    /**
     * Removes specified links from a directory.
     */
    public async removeLinksFromDirectory() {
        const directory = this.app.vault.getAbstractFileByPath(this.settings.specifiedDirectory);
        if (!(directory instanceof TFolder)) {
            new Notice('Invalid directory specified');
            return;
        }

        const files = await this.getMarkdownFiles(directory);
        const linksToRemove = this.settings.linksToRemove
            .split(',')
            .map((link) => link.trim())
            .filter(Boolean);
        let totalRemoved = 0;

        for (const file of files) {
            const content = await this.app.vault.read(file);
            const newContent = this.removeLinks(content, linksToRemove);
            if (content !== newContent) {
                await this.app.vault.modify(file, newContent);
                totalRemoved++;
            }
        }

        new Notice(
            `Removed links from ${totalRemoved} file(s) in ${this.settings.specifiedDirectory}`
        );
    }

    /**
     * Removes specified links from content.
     * @param content - The content to process.
     * @param linksToRemove - The links to remove.
     * @returns The content with links removed.
     */
    private removeLinks(content: string, linksToRemove: string[]): string {
        let newContent = content;
        for (const link of linksToRemove) {
            const pattern = new RegExp(`\\[\\[${this.escapeRegExp(link)}\\]\\]`, 'gi');
            newContent = newContent.replace(pattern, link);
        }
        return newContent;
    }

    /**
     * Undoes the last set of changes made by the plugin.
     */
    async undoLastChanges() {
        if (this.lastChanges.length === 0) {
            new Notice('No changes to undo');
            return;
        }

        for (const change of this.lastChanges) {
            await this.app.vault.modify(change.file, change.oldContent);
        }

        new Notice(`Undid changes in ${this.lastChanges.length} file(s)`);
        this.lastChanges = []; // Clear the changes after undoing
    }
}

// Settings tab class
class AutoLinkerSettingTab extends PluginSettingTab {
    plugin: AutoLinkerPlugin;

    constructor(app: App, plugin: AutoLinkerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.createEl('h2', { text: 'Auto Linker Settings' });

        // Linking settings
        this.createLinkingSettings(containerEl);

        // Management settings
        containerEl.createEl('h3', { text: 'Manage Links By Folder' });
        this.createManagementSettings(containerEl);

        // Undo changes
        this.createUndoSetting(containerEl);
    }

    /**
     * Creates settings related to linking options.
     * @param containerEl - The container element.
     */
    private createLinkingSettings(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Link Existing Files Only')
            .setDesc('Only create links for files that already exist in the vault')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.existingFilesOnly)
                    .onChange(async (value) => {
                        this.plugin.settings.existingFilesOnly = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Excluded Blocks')
            .setDesc(
                'Enter block names to exclude from linking, separated by commas (e.g., Dailies, Tasks, Notes)'
            )
            .addText((text) =>
                text
                    .setPlaceholder('Dailies, Tasks, Notes')
                    .setValue(this.plugin.settings.excludedBlocks)
                    .onChange(async (value) => {
                        this.plugin.settings.excludedBlocks = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Blacklisted Strings')
            .setDesc('Enter strings to never be linked, separated by commas (e.g., and, or, the)')
            .addText((text) =>
                text
                    .setPlaceholder('and, or, the')
                    .setValue(this.plugin.settings.blacklistedStrings)
                    .onChange(async (value) => {
                        this.plugin.settings.blacklistedStrings = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Whitelisted Strings')
            .setDesc(
                'Enter strings to be exclusively linked, separated by commas. If empty, all non-blacklisted strings will be linked.'
            )
            .addText((text) =>
                text
                    .setPlaceholder('important, keyword, topic')
                    .setValue(this.plugin.settings.whitelistedStrings)
                    .onChange(async (value) => {
                        this.plugin.settings.whitelistedStrings = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Debug Mode')
            .setDesc('Enable debug mode to see detailed logs in the console')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.debugMode)
                    .onChange(async (value) => {
                        this.plugin.settings.debugMode = value;
                        await this.plugin.saveSettings();
                    })
            );
    }

    /**
     * Creates settings related to managing links by folder.
     * @param containerEl - The container element.
     */
    private createManagementSettings(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Specified Directory')
            .setDesc('Enter the path of the directory to manage')
            .addText((text) =>
                text
                    .setPlaceholder('Example: folder/subfolder')
                    .setValue(this.plugin.settings.specifiedDirectory)
                    .onChange(async (value) => {
                        this.plugin.settings.specifiedDirectory = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Add Links')
            .setDesc('Extend linking functionality to the chosen directory')
            .addButton((button) =>
                button.setButtonText('Add Links').onClick(async () => {
                    await this.extendLinkingToDirectoryWithConfirmation();
                })
            );

        new Setting(containerEl)
            .setName('Remove Links')
            .setDesc('Remove specified links from the chosen directory')
            .addText((text) =>
                text
                    .setPlaceholder('link1, link2, link3')
                    .setValue(this.plugin.settings.linksToRemove)
                    .onChange(async (value) => {
                        this.plugin.settings.linksToRemove = value;
                        await this.plugin.saveSettings();
                    })
            )
            .addButton((button) =>
                button.setButtonText('Remove Links').onClick(async () => {
                    await this.removeLinksFromDirectoryWithConfirmation();
                })
            );
    }

    /**
     * Creates the setting to undo last changes.
     * @param containerEl - The container element.
     */
    private createUndoSetting(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Undo Last Changes')
            .setDesc('Undo the last set of changes made by the Auto Linker')
            .addButton((button) =>
                button.setButtonText('Undo Last Changes').onClick(async () => {
                    await this.plugin.undoLastChanges();
                })
            );
    }

    /**
     * Confirms and extends linking to directory.
     */
    private async extendLinkingToDirectoryWithConfirmation() {
        const confirm = await this.confirmAction(
            'Are you sure you wish to add links to the chosen directory?'
        );
        if (confirm) {
            await this.plugin.extendLinkingToDirectory();
        }
    }

    /**
     * Confirms and removes links from directory.
     */
    private async removeLinksFromDirectoryWithConfirmation() {
        const confirm = await this.confirmAction(
            'Are you sure you want to remove these links from the chosen directory?'
        );
        if (confirm) {
            await this.plugin.removeLinksFromDirectory();
        }
    }

    /**
     * Displays a confirmation modal.
     * @param message - The confirmation message.
     * @returns A promise that resolves to true if confirmed, false otherwise.
     */
    private confirmAction(message: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new ConfirmationModal(this.app, message, resolve);
            modal.open();
        });
    }
}

// Confirmation modal class
class ConfirmationModal extends Modal {
    private message: string;
    private resolve: (value: boolean) => void;

    constructor(app: App, message: string, resolve: (value: boolean) => void) {
        super(app);
        this.message = message;
        this.resolve = resolve;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('p', { text: this.message });

        new Setting(contentEl)
            .addButton((button) =>
                button
                    .setButtonText('Confirm')
                    .setCta()
                    .onClick(() => {
                        this.resolve(true);
                        this.close();
                    })
            )
            .addButton((button) =>
                button
                    .setButtonText('Cancel')
                    .onClick(() => {
                        this.resolve(false);
                        this.close();
                    })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
