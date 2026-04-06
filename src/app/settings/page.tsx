/**
 * Settings Page
 * Configure Mission Control paths, URLs, and preferences
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, Save, RotateCcw, FolderOpen, Link as LinkIcon } from 'lucide-react';
import { getConfig, updateConfig, resetConfig, type MissionControlConfig } from '@/lib/config';
import type { OpenClawModelsResponse, Workspace } from '@/lib/types';

export default function SettingsPage() {
  const router = useRouter();
  const [config, setConfig] = useState<MissionControlConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('default');
  const [autopilotModelOverride, setAutopilotModelOverride] = useState<string>('');
  const [planningModelOverride, setPlanningModelOverride] = useState<string>('');
  const [availableProviderModels, setAvailableProviderModels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingRouting, setIsSavingRouting] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [routingSaveSuccess, setRoutingSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routingError, setRoutingError] = useState<string | null>(null);

  useEffect(() => {
    setConfig(getConfig());

    const loadWorkspaceRouting = async () => {
      try {
        const [workspacesRes, modelsRes] = await Promise.all([
          fetch('/api/workspaces'),
          fetch('/api/openclaw/models'),
        ]);

        if (workspacesRes.ok) {
          const workspaceData = await workspacesRes.json() as Workspace[];
          setWorkspaces(workspaceData);

          const selected = workspaceData.find((workspace) => workspace.id === 'default') || workspaceData[0];
          if (selected) {
            setSelectedWorkspaceId(selected.id);
            setAutopilotModelOverride(selected.autopilot_model_override || '');
            setPlanningModelOverride(selected.planning_model_override || '');
          }
        }

        if (modelsRes.ok) {
          const modelsData = await modelsRes.json() as OpenClawModelsResponse;
          const allowedModels = modelsData.providerModels
            .filter((model) => model.policy_allowed)
            .map((model) => model.id)
            .sort((a, b) => a.localeCompare(b));
          setAvailableProviderModels(allowedModels);
        }
      } catch (loadError) {
        console.error('Failed to load workspace model routing settings:', loadError);
      }
    };

    loadWorkspaceRouting();
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      return;
    }

    const selected = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
    if (!selected) {
      return;
    }

    setAutopilotModelOverride(selected.autopilot_model_override || '');
    setPlanningModelOverride(selected.planning_model_override || '');
  }, [selectedWorkspaceId, workspaces]);

  const handleSave = async () => {
    if (!config) return;

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      updateConfig(config);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    if (confirm('Reset all settings to defaults? This cannot be undone.')) {
      resetConfig();
      setConfig(getConfig());
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    }
  };

  const handleSaveWorkspaceRouting = async () => {
    if (!selectedWorkspaceId) {
      return;
    }

    setIsSavingRouting(true);
    setRoutingError(null);
    setRoutingSaveSuccess(false);

    try {
      const payload = {
        autopilot_model_override: autopilotModelOverride.trim() || null,
        planning_model_override: planningModelOverride.trim() || null,
      };

      const response = await fetch(`/api/workspaces/${selectedWorkspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const responseData = await response.json();
      if (!response.ok) {
        throw new Error(responseData.error || 'Failed to save AI routing settings');
      }

      setWorkspaces((previous) => previous.map((workspace) => (
        workspace.id === selectedWorkspaceId
          ? {
              ...workspace,
              autopilot_model_override: responseData.autopilot_model_override || null,
              planning_model_override: responseData.planning_model_override || null,
            }
          : workspace
      )));

      setAutopilotModelOverride(responseData.autopilot_model_override || '');
      setPlanningModelOverride(responseData.planning_model_override || '');
      setRoutingSaveSuccess(true);
      setTimeout(() => setRoutingSaveSuccess(false), 3000);
    } catch (saveRoutingError) {
      setRoutingError(saveRoutingError instanceof Error ? saveRoutingError.message : 'Failed to save AI routing settings');
    } finally {
      setIsSavingRouting(false);
    }
  };

  const handleChange = (field: keyof MissionControlConfig, value: string) => {
    if (!config) return;
    setConfig({ ...config, [field]: value });
  };

  if (!config) {
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <div className="text-mc-text-secondary">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-mc-bg">
      {/* Header */}
      <div className="border-b border-mc-border bg-mc-bg-secondary">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/')}
              className="p-2 hover:bg-mc-bg-tertiary rounded text-mc-text-secondary"
              title="Back to Mission Control"
            >
              ← Back
            </button>
            <Settings className="w-6 h-6 text-mc-accent" />
            <h1 className="text-2xl font-bold text-mc-text">Settings</h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              className="px-4 py-2 border border-mc-border rounded hover:bg-mc-bg-tertiary text-mc-text-secondary flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Reset to Defaults
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 bg-mc-accent text-mc-bg rounded hover:bg-mc-accent/90 flex items-center gap-2 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Success Message */}
        {saveSuccess && (
          <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded text-green-400">
            ✓ Settings saved successfully
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded text-red-400">
            ✗ {error}
          </div>
        )}

        {/* Workspace AI Routing */}
        <section className="mb-8 p-6 bg-mc-bg-secondary border border-mc-border rounded-lg">
          <div className="flex items-center gap-2 mb-4">
            <Settings className="w-5 h-5 text-mc-accent" />
            <h2 className="text-xl font-semibold text-mc-text">Workspace AI Routing</h2>
          </div>
          <p className="text-sm text-mc-text-secondary mb-4">
            Set per-workspace model overrides for autopilot research and ideation, plus planning sessions.
          </p>

          {routingSaveSuccess && (
            <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-green-400 text-sm">
              ✓ Workspace routing settings saved successfully
            </div>
          )}

          {routingError && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
              ✗ {routingError}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Workspace
              </label>
              <select
                value={selectedWorkspaceId}
                onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.icon} {workspace.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Autopilot Model Override
              </label>
              <input
                type="text"
                value={autopilotModelOverride}
                onChange={(event) => setAutopilotModelOverride(event.target.value)}
                list="provider-model-options"
                placeholder="Leave blank to use default autopilot model"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                Applies to autopilot research and ideation cycles for this workspace.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Planning Model Override
              </label>
              <input
                type="text"
                value={planningModelOverride}
                onChange={(event) => setPlanningModelOverride(event.target.value)}
                list="provider-model-options"
                placeholder="Leave blank to use default planning model"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                Applied when a planning session starts for tasks in this workspace.
              </p>
            </div>

            <datalist id="provider-model-options">
              {availableProviderModels.map((modelId) => (
                <option key={modelId} value={modelId} />
              ))}
            </datalist>

            <div className="flex justify-end">
              <button
                onClick={handleSaveWorkspaceRouting}
                disabled={isSavingRouting || !selectedWorkspaceId}
                className="px-4 py-2 bg-mc-accent text-mc-bg rounded hover:bg-mc-accent/90 flex items-center gap-2 disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                {isSavingRouting ? 'Saving...' : 'Save AI Routing'}
              </button>
            </div>
          </div>
        </section>

        {/* Workspace Paths */}
        <section className="mb-8 p-6 bg-mc-bg-secondary border border-mc-border rounded-lg">
          <div className="flex items-center gap-2 mb-4">
            <FolderOpen className="w-5 h-5 text-mc-accent" />
            <h2 className="text-xl font-semibold text-mc-text">Workspace Paths</h2>
          </div>
          <p className="text-sm text-mc-text-secondary mb-4">
            Configure where Mission Control stores projects and deliverables.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Workspace Base Path
              </label>
              <input
                type="text"
                value={config.workspaceBasePath}
                onChange={(e) => handleChange('workspaceBasePath', e.target.value)}
                placeholder="~/Documents/Shared"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                Base directory for all Mission Control files. Use ~ for home directory.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Projects Path
              </label>
              <input
                type="text"
                value={config.projectsPath}
                onChange={(e) => handleChange('projectsPath', e.target.value)}
                placeholder="~/Documents/Shared/projects"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                Directory where project folders are created. Each project gets its own folder.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Default Project Name
              </label>
              <input
                type="text"
                value={config.defaultProjectName}
                onChange={(e) => handleChange('defaultProjectName', e.target.value)}
                placeholder="mission-control"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                Default name for new projects. Can be changed per project.
              </p>
            </div>
          </div>
        </section>

        {/* API Configuration */}
        <section className="mb-8 p-6 bg-mc-bg-secondary border border-mc-border rounded-lg">
          <div className="flex items-center gap-2 mb-4">
            <LinkIcon className="w-5 h-5 text-mc-accent" />
            <h2 className="text-xl font-semibold text-mc-text">API Configuration</h2>
          </div>
          <p className="text-sm text-mc-text-secondary mb-4">
            Configure Mission Control API URL for agent orchestration.
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Mission Control URL
              </label>
              <input
                type="text"
                value={config.missionControlUrl}
                onChange={(e) => handleChange('missionControlUrl', e.target.value)}
                placeholder="http://localhost:4000"
                className="w-full px-4 py-2 bg-mc-bg border border-mc-border rounded text-mc-text focus:border-mc-accent focus:outline-none"
              />
              <p className="text-xs text-mc-text-secondary mt-1">
                URL where Mission Control is running. Auto-detected by default. Change for remote access.
              </p>
            </div>
          </div>
        </section>

        {/* Environment Variables Note */}
        <section className="p-6 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <h3 className="text-lg font-semibold text-blue-400 mb-2">
            📝 Environment Variables
          </h3>
          <p className="text-sm text-blue-300 mb-3">
            Some settings are also configurable via environment variables in <code className="px-2 py-1 bg-mc-bg rounded">.env.local</code>:
          </p>
          <ul className="text-sm text-blue-300 space-y-1 ml-4 list-disc">
            <li><code>MISSION_CONTROL_URL</code> - API URL override</li>
            <li><code>WORKSPACE_BASE_PATH</code> - Base workspace directory</li>
            <li><code>PROJECTS_PATH</code> - Projects directory</li>
            <li><code>OPENCLAW_GATEWAY_URL</code> - Gateway WebSocket URL</li>
            <li><code>OPENCLAW_GATEWAY_TOKEN</code> - Gateway auth token</li>
          </ul>
          <p className="text-xs text-blue-400 mt-3">
            Environment variables take precedence over UI settings for server-side operations.
          </p>
        </section>
      </div>
    </div>
  );
}
