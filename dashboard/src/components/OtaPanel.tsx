'use client';

import React, { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AppReleaseItem, OtaConfig } from '@/lib/types';
import { Badge, Button, Empty, Input, Panel } from './primitives';

export function OtaPanel() {
  const [releases, setReleases] = useState<AppReleaseItem[]>([]);
  const [config, setConfig] = useState<OtaConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [versionName, setVersionName] = useState('');
  const [versionCode, setVersionCode] = useState('');
  const [platform, setPlatform] = useState('android');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [mandatory, setMandatory] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Config settings form state
  const [minVersion, setMinVersion] = useState('1');
  const [testflightUrl, setTestflightUrl] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await api.getReleases();
      setReleases(res.releases || []);
      setConfig(res.config);
      setMinVersion(String(res.config?.minSupportedVersionCode || 1));
      setTestflightUrl(res.config?.iosTestflightUrl || '');
    } catch (e: any) {
      setError(e?.message || 'Failed to load app releases');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateRelease = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!versionName.trim() || !versionCode || !downloadUrl.trim()) return;

    setSubmitting(true);
    setError('');
    try {
      await api.createRelease({
        versionName: versionName.trim(),
        versionCode: parseInt(versionCode, 10),
        platform,
        downloadUrl: downloadUrl.trim(),
        releaseNotes: releaseNotes.trim(),
        mandatory,
      });
      setSuccess(`Release ${versionName} published successfully.`);
      setShowAddModal(false);
      setVersionName('');
      setVersionCode('');
      setDownloadUrl('');
      setReleaseNotes('');
      setMandatory(false);
      await loadData();
    } catch (e: any) {
      setError(e?.message || 'Failed to publish release');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleMandatory = async (release: AppReleaseItem) => {
    try {
      await api.updateRelease(release.id, { mandatory: !release.mandatory });
      await loadData();
    } catch (e: any) {
      setError(e?.message || 'Failed to update release');
    }
  };

  const handleToggleActive = async (release: AppReleaseItem) => {
    try {
      await api.updateRelease(release.id, { active: !release.active });
      await loadData();
    } catch (e: any) {
      setError(e?.message || 'Failed to update release');
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete release ${name}? Mobile clients will no longer be offered this version.`)) return;
    try {
      await api.deleteRelease(id);
      await loadData();
    } catch (e: any) {
      setError(e?.message || 'Failed to delete release');
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingConfig(true);
    setError('');
    try {
      await api.updateOtaConfig({
        minSupportedVersionCode: parseInt(minVersion, 10) || 1,
        iosTestflightUrl: testflightUrl.trim(),
      });
      setSuccess('OTA distribution settings updated.');
      await loadData();
    } catch (e: any) {
      setError(e?.message || 'Failed to update config');
    } finally {
      setSavingConfig(false);
    }
  };

  const latestAndroid = releases.find((r) => r.active && (r.platform === 'android' || r.platform === 'universal'));

  return (
    <div className="flex flex-col gap-6">
      {/* Hero Stats & CI/CD Quick Reference */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="glass-panel rounded-2xl p-5 border border-white/8">
          <div className="text-xs font-semibold text-slate-400">Active Mobile Version</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">
              {latestAndroid ? `v${latestAndroid.versionName}` : 'None Active'}
            </span>
            {latestAndroid && (
              <span className="text-xs font-mono text-emerald-400">
                (Build #{latestAndroid.versionCode})
              </span>
            )}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            {latestAndroid?.mandatory ? '🚨 Mandatory update enforced' : '🟢 Standard update available'}
          </p>
        </div>

        <div className="glass-panel rounded-2xl p-5 border border-white/8">
          <div className="text-xs font-semibold text-slate-400">Minimum Supported Build</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-indigo-400">
              Build #{config?.minSupportedVersionCode ?? 1}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            App builds below this number are blocked with mandatory update prompt.
          </p>
        </div>

        <div className="glass-panel rounded-2xl p-5 border border-white/8">
          <div className="text-xs font-semibold text-slate-400">GitHub Actions CI/CD Tag</div>
          <div className="mt-1 font-mono text-sm font-bold text-slate-200">
            git tag v1.0.X && git push --tags
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Pushes matching <code>v*</code> automatically build APK & publish release.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs font-semibold text-rose-300">
          ⚠️ {error}
        </div>
      )}

      {success && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs font-semibold text-emerald-300">
          ✅ {success}
        </div>
      )}

      {/* Main Releases List Panel */}
      <Panel
        title="Mobile App Releases & OTA Distribution"
        subtitle="Manage in-house APK builds and iOS distribution without public App Stores"
        icon={
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
        }
        actions={
          <Button variant="accent" size="sm" onClick={() => setShowAddModal(true)}>
            + Register Release
          </Button>
        }
      >
        {loading ? (
          <div className="py-8 text-center text-xs text-slate-400">Loading releases…</div>
        ) : releases.length === 0 ? (
          <Empty
            title="No Releases Published Yet"
            description="Push a version tag (e.g. v1.0.1) on GitHub or click '+ Register Release' to register an APK download URL."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="border-b border-white/10 bg-slate-900/50 text-[11px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-3 px-4">Version & Tag</th>
                  <th className="py-3 px-4">Platform</th>
                  <th className="py-3 px-4">Release Notes</th>
                  <th className="py-3 px-4">Enforcement</th>
                  <th className="py-3 px-4">Published At</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {releases.map((r) => (
                  <tr key={r.id} className={`transition-colors hover:bg-slate-900/40 ${r.active ? '' : 'opacity-40'}`}>
                    <td className="py-3.5 px-4 font-mono">
                      <div className="font-bold text-white flex items-center gap-2">
                        v{r.versionName}
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400 border border-slate-700">
                          #{r.versionCode}
                        </span>
                        {r.active && (
                          <span className="inline-flex items-center rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
                            ACTIVE
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate max-w-[200px]" title={r.downloadUrl}>
                        {r.downloadUrl}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="inline-flex rounded-md bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-300 border border-indigo-500/20">
                        {r.platform}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 max-w-[260px]">
                      <div className="line-clamp-2 text-slate-300 text-[11px] whitespace-pre-line">
                        {r.releaseNotes || 'No changelog notes.'}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <button
                        onClick={() => handleToggleMandatory(r)}
                        className={`rounded-full px-2.5 py-1 text-[10px] font-bold transition-all ${
                          r.mandatory
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30 hover:bg-rose-500/30'
                            : 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700'
                        }`}
                        title="Click to toggle mandatory vs optional"
                      >
                        {r.mandatory ? '🚨 Mandatory' : 'Optional'}
                      </button>
                    </td>
                    <td className="py-3.5 px-4 text-slate-400 text-[11px]">
                      {r.publishedAt}
                    </td>
                    <td className="py-3.5 px-4 text-right space-x-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleToggleActive(r)}
                      >
                        {r.active ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => handleDelete(r.id, r.versionName)}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Distribution Configuration Card */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel
          title="OTA Policy & Enforcement"
          subtitle="Configure minimum supported versions and iOS links"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          }
        >
          <form onSubmit={handleSaveConfig} className="flex flex-col gap-4">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-300">
                Minimum Supported Version Code
              </label>
              <Input
                type="number"
                value={minVersion}
                onChange={(e) => setMinVersion(e.target.value)}
                placeholder="e.g. 1"
                required
              />
              <p className="mt-1 text-[11px] text-slate-400">
                Phones running a build lower than this will be blocked with a mandatory update screen.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-300">
                iOS TestFlight Invite / App Link
              </label>
              <Input
                value={testflightUrl}
                onChange={(e) => setTestflightUrl(e.target.value)}
                placeholder="https://testflight.apple.com/join/..."
              />
              <p className="mt-1 text-[11px] text-slate-400">
                When iOS employees tap 'Update Now', this internal link is opened.
              </p>
            </div>

            <Button variant="accent" type="submit" disabled={savingConfig}>
              {savingConfig ? 'Saving…' : 'Save OTA Settings'}
            </Button>
          </form>
        </Panel>

        <Panel
          title="Automated GitHub Actions CI/CD Guide"
          subtitle="Publishing official updates to employee phones"
          icon={
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          }
        >
          <div className="flex flex-col gap-3 text-xs text-slate-300">
            <div className="rounded-xl border border-white/8 bg-slate-900/60 p-3.5">
              <div className="font-bold text-white mb-1">1. Update version in Flutter</div>
              <p className="text-[11px] text-slate-400 font-mono">
                forgottenwomen/pubspec.yaml &rarr; version: 1.0.1+2
              </p>
            </div>

            <div className="rounded-xl border border-white/8 bg-slate-900/60 p-3.5">
              <div className="font-bold text-white mb-1">2. Push Git Version Tag</div>
              <pre className="rounded bg-slate-950 p-2 font-mono text-[11px] text-emerald-400">
                git tag v1.0.1{'\n'}git push origin v1.0.1
              </pre>
            </div>

            <div className="rounded-xl border border-white/8 bg-slate-900/60 p-3.5">
              <div className="font-bold text-white mb-1">3. Automated Build & Delivery</div>
              <p className="text-[11px] text-slate-400">
                GitHub Actions will build the release APK and publish the release. All staff phones will detect the update on next app launch.
              </p>
            </div>
          </div>
        </Panel>
      </div>

      {/* Register Release Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-[#0F172A] p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-white">Register App Release</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white">
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateRelease} className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-300">Version Name *</label>
                  <Input
                    value={versionName}
                    onChange={(e) => setVersionName(e.target.value)}
                    placeholder="e.g. 1.0.1"
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-300">Version Code (Build #) *</label>
                  <Input
                    type="number"
                    value={versionCode}
                    onChange={(e) => setVersionCode(e.target.value)}
                    placeholder="e.g. 2"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-300">Platform</label>
                  <select
                    value={platform}
                    onChange={(e) => setPlatform(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="android">Android (.apk)</option>
                    <option value="ios">iOS (TestFlight / IPA)</option>
                    <option value="universal">Universal</option>
                  </select>
                </div>
                <div className="flex items-center pt-5">
                  <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-300">
                    <input
                      type="checkbox"
                      checked={mandatory}
                      onChange={(e) => setMandatory(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
                    />
                    Mandatory Update
                  </label>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-300">Download URL *</label>
                <Input
                  value={downloadUrl}
                  onChange={(e) => setDownloadUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo/releases/download/v1.0.1/app-release.apk"
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-300">Release Notes / Changelog</label>
                <textarea
                  value={releaseNotes}
                  onChange={(e) => setReleaseNotes(e.target.value)}
                  rows={3}
                  className="w-full rounded-xl border border-white/10 bg-slate-900 p-3 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                  placeholder="• Fixed working days salary calculation&#10;• Added OTA in-app updater"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button variant="secondary" onClick={() => setShowAddModal(false)}>
                  Cancel
                </Button>
                <Button variant="accent" type="submit" disabled={submitting}>
                  {submitting ? 'Publishing…' : 'Publish Release'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
