import { useState, useMemo } from 'react';
import {
  ArrowLeftRight,
  BookOpen,
  Check,
  Code,
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  Globe,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  Mic,
  Plus,
  Radio,
  Search,
  Sparkles,
  Trash2,
  Video,
  Volume2,
  X,
} from 'lucide-react';
import { useSkillsStrings } from '../skills-strings';
import {
  useSkills,
  useCreateCustomSkill,
  useUpdateCustomSkill,
  useDeleteCustomSkill,
} from '../skills-api';
import type { SkillCategory, SkillSummary } from '../skills-types';
import { useUserSession } from '../../use-session';
import { askConfirm } from '../shell/confirm'

function getSkillIcon(category: string, iconName?: string) {
  switch (iconName || category) {
    case 'Hub':
    case 'entry':
      return BookOpen;
    case 'MessageSquare':
    case 'chat':
      return MessageSquare;
    case 'Image':
    case 'media':
      return ImageIcon;
    case 'Video':
      return Video;
    case 'Volume2':
    case 'audio':
      return Volume2;
    case 'Mic':
      return Mic;
    case 'Layers':
    case 'data':
      return Layers;
    case 'Search':
    case 'search':
      return Search;
    case 'Globe':
      return Globe;
    case 'ArrowLeftRight':
    case 'tools':
      return ArrowLeftRight;
    default:
      return Code;
  }
}

export default function SkillsHub() {
  const s = useSkillsStrings();
  const session = useUserSession();
  const canEdit = session.hasPermission('edit_x_settings');

  const { data, isLoading, isError, refetch } = useSkills();
  const createMutation = useCreateCustomSkill();
  const updateMutation = useUpdateCustomSkill();
  const deleteMutation = useDeleteCustomSkill();

  const [selectedCategory, setSelectedCategory] = useState<SkillCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [previewSkill, setPreviewSkill] = useState<SkillSummary | null>(null);
  const [useTunnelUrl, setUseTunnelUrl] = useState(true);

  // Custom skill modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillSummary | null>(null);
  const [formId, setFormId] = useState('');
  const [formName, setFormName] = useState('');
  const [formCategory, setFormCategory] = useState<'entry' | 'chat' | 'media' | 'audio' | 'data' | 'search' | 'tools' | 'custom'>('custom');
  const [formDesc, setFormDesc] = useState('');
  const [formEndpoint, setFormEndpoint] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const tunnelAvailable = Boolean(data?.tunnelActive && data?.tunnelUrl);
  const effectiveBaseUrl = (tunnelAvailable && useTunnelUrl ? data?.tunnelUrl : data?.resolvedBaseUrl) || 'http://localhost:3001';

  const entrySkill = useMemo(() => {
    return data?.skills.find((item) => item.isEntry) || data?.skills[0];
  }, [data]);

  const heroPromptUrl = entrySkill
    ? `${effectiveBaseUrl}/thruline-skills/${entrySkill.id}/SKILL.md`
    : `${effectiveBaseUrl}/thruline-skills/9router/SKILL.md`;

  const heroPromptText = `Read this skill and use it: ${heroPromptUrl}`;

  const handleCopy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((curr) => (curr === id ? null : curr));
    }, 2000);
  };

  const filteredSkills = useMemo(() => {
    if (!data?.skills) return [];
    return data.skills.filter((skill) => {
      // Category filter
      if (selectedCategory === 'custom' && !skill.isCustom) return false;
      if (selectedCategory !== 'all' && selectedCategory !== 'custom' && skill.category !== selectedCategory) {
        return false;
      }
      // Search filter
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();
      return (
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.id.toLowerCase().includes(q) ||
        (skill.endpoint && skill.endpoint.toLowerCase().includes(q))
      );
    });
  }, [data, selectedCategory, searchQuery]);

  const openCreateModal = () => {
    setEditingSkill(null);
    setFormId('');
    setFormName('');
    setFormCategory('custom');
    setFormDesc('');
    setFormEndpoint('');
    setFormContent('---\nname: my-agent-skill\ndescription: Custom guidelines and instructions for coding agents.\n---\n\n# Custom Skill\n\nWrite your agent instructions here.');
    setFormError(null);
    setIsModalOpen(true);
  };

  const openEditModal = (skill: SkillSummary) => {
    setEditingSkill(skill);
    setFormId(skill.id);
    setFormName(skill.name);
    setFormCategory(skill.category);
    setFormDesc(skill.description);
    setFormEndpoint(skill.endpoint || '');
    setFormContent(skill.content);
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formName.trim() || !formDesc.trim() || !formContent.trim()) {
      setFormError('Please fill in all required fields.');
      return;
    }

    try {
      if (editingSkill) {
        await updateMutation.mutateAsync({
          id: editingSkill.id,
          patch: {
            name: formName,
            category: formCategory,
            description: formDesc,
            endpoint: formEndpoint.trim() || null,
            content: formContent,
          },
        });
      } else {
        if (!formId.trim()) {
          setFormError('Skill Identifier is required.');
          return;
        }
        await createMutation.mutateAsync({
          id: formId,
          name: formName,
          category: formCategory,
          description: formDesc,
          endpoint: formEndpoint.trim() || null,
          content: formContent,
        });
      }
      setIsModalOpen(false);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Operation failed');
    }
  };

  const handleDelete = async (skill: SkillSummary) => {
    if (!await askConfirm(s.confirmDelete)) return;
    try {
      await deleteMutation.mutateAsync(skill.id);
      if (previewSkill?.id === skill.id) {
        setPreviewSkill(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="x-page space-y-6 max-w-6xl mx-auto pb-12">
      {/* Page Heading */}
      <div className="x-page-heading flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{s.skillsTitle}</h1>
            <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-primary/10 text-primary border border-primary/20">
              SKILL.md
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">{s.skillsSubtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <button
              onClick={openCreateModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition shadow-sm"
            >
              <Plus size={14} />
              {s.createCustomSkill}
            </button>
          )}
        </div>
      </div>

      {/* Hero Quick Copy Instruction Card */}
      <div className="p-5 rounded-2xl border border-primary/30 bg-gradient-to-r from-primary/5 via-primary/10 to-transparent shadow-sm space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-primary" />
            <span className="font-semibold text-sm text-foreground">{s.heroPromptLabel}</span>
          </div>
          {tunnelAvailable && (
            <button
              onClick={() => setUseTunnelUrl(!useTunnelUrl)}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-background/80 border border-primary/20 hover:border-primary/40 text-foreground transition"
              title={useTunnelUrl ? s.switchToLocal : s.switchToTunnel}
            >
              <Radio size={13} className={useTunnelUrl ? 'text-emerald-500 animate-pulse' : 'text-muted-foreground'} />
              <span>{useTunnelUrl ? s.tunnelActiveBadge : s.localUrlBadge}</span>
              <span className="text-[10px] text-primary underline ml-1">
                ({useTunnelUrl ? s.switchToLocal : s.switchToTunnel})
              </span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 bg-background/90 dark:bg-zinc-900 border border-border rounded-xl p-2.5 font-mono text-xs text-foreground shadow-inner">
          <div className="flex-1 overflow-x-auto whitespace-nowrap select-all text-xs font-medium">
            {heroPromptText}
          </div>
          <button
            onClick={() => handleCopy(heroPromptText, 'hero')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition shrink-0 shadow-sm"
          >
            {copiedId === 'hero' ? <Check size={14} /> : <Copy size={14} />}
            <span>{copiedId === 'hero' ? s.copied : s.copyPrompt}</span>
          </button>
        </div>

        <p className="text-xs text-muted-foreground">{s.heroHelp}</p>
      </div>

      {/* Filter Tabs and Search Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-1 overflow-x-auto pb-1 text-xs">
          {(
            [
              { key: 'all', label: s.categoryAll },
              { key: 'entry', label: s.categoryEntry },
              { key: 'chat', label: s.categoryChat },
              { key: 'media', label: s.categoryMedia },
              { key: 'audio', label: s.categoryAudio },
              { key: 'data', label: s.categoryData },
              { key: 'search', label: s.categorySearch },
              { key: 'tools', label: s.categoryTools },
              { key: 'custom', label: s.categoryCustom },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setSelectedCategory(tab.key)}
              className={`px-3 py-1.5 rounded-lg font-medium transition whitespace-nowrap ${selectedCategory === tab.key
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-64 shrink-0">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={s.searchPlaceholder}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-border bg-background focus:outline-hidden focus:ring-1 focus:ring-primary text-foreground"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Loading & Error States */}
      {isLoading && (
        <div className="text-center py-12 text-muted-foreground text-sm space-y-2">
          <div className="animate-spin inline-block size-6 border-2 border-primary border-t-transparent rounded-full" />
          <p>{s.loading}</p>
        </div>
      )}

      {isError && (
        <div className="p-4 rounded-xl border border-destructive/30 bg-destructive/5 text-destructive text-sm flex items-center justify-between">
          <span>{s.errorLoading}</span>
          <button onClick={() => void refetch()} className="px-3 py-1 rounded bg-destructive text-destructive-foreground text-xs">
            {s.retry}
          </button>
        </div>
      )}

      {/* Skills Card Grid */}
      {!isLoading && !isError && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredSkills.map((skill) => {
            const IconComponent = getSkillIcon(skill.category, skill.icon);
            const rawSkillUrl = `${effectiveBaseUrl}/thruline-skills/${skill.id}/SKILL.md`;
            const promptText = `Read this skill and use it: ${rawSkillUrl}`;

            return (
              <div
                key={skill.id}
                className={`flex flex-col justify-between p-4 rounded-xl border transition-all shadow-xs ${skill.isEntry
                    ? 'border-primary/40 bg-primary/5 hover:border-primary/60'
                    : 'border-border bg-card hover:border-border/80 hover:shadow-sm'
                  }`}
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${skill.isEntry
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-primary/10 text-primary dark:bg-primary/20'
                          }`}
                      >
                        <IconComponent size={18} />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <h3 className="font-semibold text-sm text-foreground">{skill.name}</h3>
                          {skill.isEntry && (
                            <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-sm bg-primary text-primary-foreground">
                              {s.badgeStartHere}
                            </span>
                          )}
                          {skill.isCustom && (
                            <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-sm bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                              {s.badgeCustom}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-muted-foreground mt-0.5">{skill.id}</div>
                      </div>
                    </div>

                    {skill.endpoint && (
                      <span className="px-2 py-0.5 rounded-md bg-muted text-[11px] font-mono text-foreground shrink-0 border border-border/50">
                        {skill.endpoint}
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                    {skill.description}
                  </p>

                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>
                      {s.tokenEstimate}: <strong className="text-foreground">{skill.tokenEstimate}</strong>
                    </span>
                    <span>•</span>
                    <span className="truncate max-w-[200px]" title={rawSkillUrl}>
                      {rawSkillUrl}
                    </span>
                  </div>
                </div>

                <div className="pt-3 mt-3 border-t border-border/60 flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleCopy(promptText, `prompt-${skill.id}`)}
                      className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition inline-flex items-center gap-1 shadow-xs"
                      title={promptText}
                    >
                      {copiedId === `prompt-${skill.id}` ? <Check size={13} /> : <Copy size={13} />}
                      <span>{copiedId === `prompt-${skill.id}` ? s.copied : s.copyPrompt}</span>
                    </button>

                    <button
                      onClick={() => handleCopy(rawSkillUrl, `link-${skill.id}`)}
                      className="px-2 py-1 rounded-md bg-muted hover:bg-muted/80 text-foreground text-xs transition inline-flex items-center gap-1"
                      title={rawSkillUrl}
                    >
                      {copiedId === `link-${skill.id}` ? <Check size={12} /> : <Copy size={12} />}
                      <span>{copiedId === `link-${skill.id}` ? s.copied : s.copyLink}</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setPreviewSkill(skill)}
                      className="px-2 py-1 rounded-md border border-border hover:bg-muted/50 text-foreground text-xs transition inline-flex items-center gap-1"
                      title={s.previewSkill}
                    >
                      <Eye size={12} />
                      <span>{s.previewSkill}</span>
                    </button>

                    {skill.githubUrl && (
                      <a
                        href={skill.githubUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition inline-flex items-center"
                        title={s.openGitHub}
                      >
                        <ExternalLink size={13} />
                      </a>
                    )}

                    {skill.isCustom && canEdit && (
                      <>
                        <button
                          onClick={() => openEditModal(skill)}
                          className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition"
                          title={s.editSkill}
                        >
                          <Edit3 size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(skill)}
                          className="p-1 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition"
                          title={s.deleteSkill}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !isError && filteredSkills.length === 0 && (
        <div className="text-center py-12 border border-dashed rounded-2xl p-8 space-y-3">
          <Filter size={32} className="mx-auto text-muted-foreground" />
          <h3 className="font-semibold text-base text-foreground">{s.emptySearch}</h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">{s.emptySearchDesc}</p>
          {selectedCategory === 'custom' && canEdit && (
            <button
              onClick={openCreateModal}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition shadow-sm"
            >
              <Plus size={14} />
              {s.createCustomSkill}
            </button>
          )}
        </div>
      )}

      {/* SKILL.md Preview Drawer / Modal */}
      {previewSkill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-xs">
          <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in-50 zoom-in-95">
            <div className="p-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText size={18} className="text-primary" />
                <div>
                  <h2 className="font-semibold text-sm text-foreground">{previewSkill.name}</h2>
                  <div className="text-[11px] font-mono text-muted-foreground">
                    {previewSkill.id} • ~{previewSkill.tokenEstimate} tokens
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleCopy(previewSkill.content, `modal-${previewSkill.id}`)}
                  className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition inline-flex items-center gap-1 shadow-xs"
                >
                  {copiedId === `modal-${previewSkill.id}` ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copiedId === `modal-${previewSkill.id}` ? s.copied : s.copyPrompt}</span>
                </button>
                <button
                  onClick={() => setPreviewSkill(null)}
                  className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="flex-1 p-4 overflow-y-auto bg-muted/20">
              <pre className="p-4 rounded-xl bg-background border border-border text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap leading-relaxed select-all">
                {previewSkill.content}
              </pre>
            </div>

            <div className="p-3 border-t border-border bg-muted/10 flex items-center justify-between text-xs text-muted-foreground">
              <span>Endpoint: {previewSkill.endpoint || 'Global'}</span>
              <button
                onClick={() => setPreviewSkill(null)}
                className="px-3 py-1 rounded-md border border-border hover:bg-muted text-foreground transition"
              >
                {s.closePreview}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit Custom Skill Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-xs">
          <div className="bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Code size={18} className="text-primary" />
                <h2 className="font-semibold text-sm text-foreground">
                  {editingSkill ? s.editSkillTitle : s.newSkillTitle}
                </h2>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveForm} className="flex-1 flex flex-col overflow-hidden">
              <div className="p-4 overflow-y-auto space-y-4 text-xs">
                {formError && (
                  <div className="p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-destructive text-xs">
                    {formError}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-foreground mb-1">{s.fieldId}</label>
                    <input
                      type="text"
                      disabled={Boolean(editingSkill)}
                      value={formId}
                      onChange={(e) => setFormId(e.target.value)}
                      placeholder="e.g. team-code-standards"
                      className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-foreground focus:ring-1 focus:ring-primary disabled:opacity-50"
                      required
                    />
                    <p className="text-[10px] text-muted-foreground mt-0.5">{s.fieldIdHelp}</p>
                  </div>

                  <div>
                    <label className="block font-medium text-foreground mb-1">{s.fieldName}</label>
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="e.g. Team Coding Guidelines"
                      className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-foreground focus:ring-1 focus:ring-primary"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-foreground mb-1">{s.fieldCategory}</label>
                    <select
                      value={formCategory}
                      onChange={(e) => setFormCategory(e.target.value as SkillSummary['category'])}
                      className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-foreground focus:ring-1 focus:ring-primary"
                    >
                      <option value="custom">Custom Rules</option>
                      <option value="chat">Chat & Code</option>
                      <option value="tools">Tools</option>
                      <option value="media">Media</option>
                      <option value="audio">Audio</option>
                      <option value="data">Data</option>
                      <option value="search">Search</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-medium text-foreground mb-1">{s.fieldEndpoint}</label>
                    <input
                      type="text"
                      value={formEndpoint}
                      onChange={(e) => setFormEndpoint(e.target.value)}
                      placeholder="e.g. /v1/chat/completions"
                      className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-foreground focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-medium text-foreground mb-1">{s.fieldDescription}</label>
                  <input
                    type="text"
                    value={formDesc}
                    onChange={(e) => setFormDesc(e.target.value)}
                    placeholder="Brief description of when and how agents should use this skill"
                    className="w-full px-3 py-1.5 rounded-lg border border-border bg-background text-foreground focus:ring-1 focus:ring-primary"
                    required
                  />
                </div>

                <div>
                  <label className="block font-medium text-foreground mb-1">{s.fieldContent}</label>
                  <textarea
                    rows={10}
                    value={formContent}
                    onChange={(e) => setFormContent(e.target.value)}
                    placeholder="---&#10;name: skill-name&#10;description: ...&#10;---&#10;&#10;# Markdown instructions..."
                    className="w-full p-3 rounded-lg border border-border bg-background font-mono text-xs text-foreground focus:ring-1 focus:ring-primary leading-relaxed"
                    required
                  />
                </div>
              </div>

              <div className="p-3 border-t border-border bg-muted/10 flex items-center justify-end gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3 py-1.5 rounded-lg border border-border hover:bg-muted text-foreground transition"
                >
                  {s.cancel}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition shadow-xs disabled:opacity-50"
                >
                  {createMutation.isPending || updateMutation.isPending ? s.saving : s.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

