import fs from 'fs-extra';
import yaml from 'js-yaml';
import path from 'path';
import { Agent, getAgentDefinition } from '../constants';

interface SkillMetadata {
  name: string;
  description: string;
  priority: string;
  triggers: {
    files?: string[];
    keywords?: string[];
  };
}

/**
 * Service for generating and managing the Agent Skills Index in markdown format.
 * It handles parsing skill metadata, injecting the index into documentation,
 * and bridging agent-specific rule files.
 */
export class IndexGeneratorService {
  /**
   * Generates a markdown index of available skills across multiple categories.
   * @param baseDir The base directory containing categories and skills
   * @param frameworks List of framework categories to include in the index
   * @param format The output format: 'detailed' (3 columns) or 'compact' (2 columns)
   * @returns A formatted markdown string representing the index
   */
  async generate(
    baseDir: string,
    frameworks: string[],
    format: 'detailed' | 'compact' = 'compact',
  ): Promise<string> {
    const categories = ['common', ...frameworks];
    const entries: string[] = [];

    for (const category of categories) {
      const categoryPath = path.join(baseDir, category);
      if (!(await fs.pathExists(categoryPath))) continue;

      const skills = await fs.readdir(categoryPath);
      for (const skill of skills) {
        const skillPath = path.join(categoryPath, skill, 'SKILL.md');
        if (!(await fs.pathExists(skillPath))) continue;

        const metadata = await this.parseSkill(skillPath);
        if (metadata) {
          const entry = this.formatEntry(category, skill, metadata, format);
          entries.push(entry);
        }
      }
    }

    return this.assembleIndex(entries, format);
  }

  /**
   * Injects the generated index into target documentation files (e.g., AGENTS.md).
   * It uses HTML comments as markers for safe injection and replacement.
   * @param rootDir Project root directory
   * @param indexContent The markdown content to inject
   */
  async inject(rootDir: string, indexContent: string): Promise<void> {
    const targets = ['AGENTS.md'];
    for (const target of targets) {
      const targetPath = path.join(rootDir, target);
      let content = '';

      if (await fs.pathExists(targetPath)) {
        content = await fs.readFile(targetPath, 'utf8');
        const markerStart = '<!-- SKILLS_INDEX_START -->';
        const markerEnd = '<!-- SKILLS_INDEX_END -->';

        const startIndex = content.indexOf(markerStart);
        const endIndex = content.indexOf(markerEnd);

        if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
          // Both markers exist and are in the correct order
          const preMarker = content.substring(
            0,
            startIndex + markerStart.length,
          );
          const postMarker = content.substring(endIndex);
          content = `${preMarker}\n${indexContent}\n${postMarker}`;
        } else if (startIndex !== -1 || endIndex !== -1) {
          // One of the markers is missing or they are out of order
          // This is a damaged state, we should probably append at the end to be safe,
          // but first let's try to remove any lone markers to avoid further damage.
          content = content.replace(markerStart, '').replace(markerEnd, '');
          content =
            content.trimEnd() +
            `\n\n${markerStart}\n${indexContent}\n${markerEnd}\n`;
        } else {
          // No markers found
          content =
            content.trimEnd() +
            `\n\n${markerStart}\n${indexContent}\n${markerEnd}\n`;
        }
      } else {
        content = `<!-- SKILLS_INDEX_START -->\n${indexContent}\n<!-- SKILLS_INDEX_END -->\n`;
      }

      await fs.outputFile(targetPath, content);
    }
  }

  /**
   * Bridges native agent rule files to AGENTS.md by creating discovery instructions.
   * Creates agent-specific rule files (e.g., .mdc, .instructions.md) in their respective directories.
   * @param rootDir Project root directory
   * @param agents List of agents to generate rules for
   */
  async bridge(rootDir: string, agents: Agent[]): Promise<void> {
    const fileNameBase = 'agent-skill-standard-rule';

    for (const agentId of agents) {
      const def = getAgentDefinition(agentId);
      const isCursor = agentId === Agent.Cursor;
      const isAntigravity = agentId === Agent.Antigravity;
      const isCopilot = agentId === Agent.Copilot;

      let extension = '.md';
      if (isCursor) extension = '.mdc';
      if (isCopilot) extension = '.instructions.md';

      const fileName = `${fileNameBase}${extension}`;

      // If ruleFile is a specific file path (legacy), we use its directory.
      // Otherwise, we use it as the target directory.
      const ruleTargetDir =
        def.ruleFile.endsWith('.md') || def.ruleFile.endsWith('.mdc')
          ? path.dirname(def.ruleFile)
          : def.ruleFile;

      const ruleFilePath = path.join(rootDir, ruleTargetDir, fileName);

      // Ensure directory exists
      await fs.ensureDir(path.dirname(ruleFilePath));

      let content = '';

      if (isCursor || isAntigravity || isCopilot) {
        const description =
          'Rule for Agent Skills Standard - Always consult AGENTS.md for consolidated project context and technical triggers.';
        const contentLines = ['---', `description: ${description}`];

        if (isCursor || isAntigravity) {
          contentLines.push('globs: ["**/*"]', 'alwaysApply: true');
        } else if (isCopilot) {
          contentLines.push('applyTo: "**/*"');
        }

        contentLines.push('---', '', '');
        content = contentLines.join('\n');
      }

      content += [
        '# 🛠 Agent Skills Standard',
        '',
        'This project uses a modular skills library for specialized engineering tasks.',
        '',
        '> [!IMPORTANT]',
        '> ALWAYS consult the consolidated index in **AGENTS.md** to identify relevant triggers before acting.',
        '',
        'The `AGENTS.md` file contains mapping between project files and the specific agent skills located in the respective agent-specific folders (e.g., `.cursor/skills`, `.claude/skills`).',
      ].join('\n');

      await fs.outputFile(ruleFilePath, content);
    }
  }

  private async parseSkill(skillPath: string): Promise<SkillMetadata | null> {
    try {
      const content = await fs.readFile(skillPath, 'utf8');
      const frontmatterMatch = content.match(
        /^---\n([\s\S]*?)\n---\n([\s\S]*)$/,
      );

      if (!frontmatterMatch) return null;

      const fm = yaml.load(frontmatterMatch[1]) as unknown as {
        name?: string;
        description?: string;
        metadata?: {
          triggers?: {
            files?: string[];
            keywords?: string[];
          };
        };
      };
      const body = frontmatterMatch[2];

      const priorityMatch = body.match(/## \*\*Priority:\s*([^*]+)\*\*/);
      const priority = priorityMatch ? priorityMatch[1].trim() : 'P1';

      return {
        name: fm.name || '',
        description: fm.description || '',
        priority,
        triggers:
          (fm.metadata?.triggers as {
            files?: string[];
            keywords?: string[];
          }) || {},
      };
    } catch {
      return null;
    }
  }

  private formatEntry(
    category: string,
    skill: string,
    metadata: SkillMetadata,
    format: 'detailed' | 'compact',
  ): string {
    const id = `${category}/${skill}`;
    const prefix = metadata.priority.startsWith('P0') ? '🚨' : '';

    if (format === 'detailed') {
      const triggers = [
        ...(metadata.triggers.files || []),
        ...(metadata.triggers.keywords || []),
      ].join(',');
      return `| ${id} | \`${triggers}\` | ${prefix}${metadata.description} |`;
    }

    // Compact format: | cat/skill | 🚨desc |
    let desc = metadata.description || '';
    if (desc.length > 12) {
      desc = desc.substring(0, 11) + '…';
    }
    return `| ${id} | ${prefix}${desc} |`;
  }

  /**
   * Assembles the full index markdown including headers and Zero-Trust rules.
   * @param entries List of formatted skill entries
   * @param format The format of the entries ('detailed' or 'compact')
   * @returns Complete markdown index string
   */
  public assembleIndex(
    entries: string[],
    format: 'detailed' | 'compact' = 'detailed',
  ): string {
    const isDetailed = format === 'detailed';

    const header = [
      '# Agent Skills Index',
      '',
      '## **Rule Zero: Zero-Trust Engineering**',
      '',
      '🚨 **IMPORTANT:** Never assume existing code follows the standard. Existing files may contain legacy technical debt or non-compliant patterns (e.g., hardcoded colors).',
      '',
      '- **Skill Authority:** Loaded skills always override existing code patterns.',
      '- **Retrieval-First:** Before writing a single line of code, identify and read relevant skill files listed below.',
      '- **Audit Before Write:** Audit every file write against the `common/feedback-reporter` skill.',
      '',
      'IMPORTANT: Prefer retrieval-led reasoning. Consult skill files before acting.',
      '',
      isDetailed
        ? '| Skill ID | Triggers | Description |'
        : '| Skill ID | Description |',
      isDetailed ? '| :--- | :--- | :--- |' : '| :--- | :--- |',
    ].join('\n');

    return `${header}\n${entries.join('\n')}\n`;
  }
}
