'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import {
  DocumentTypeOption,
  PendingVerificationDoc,
  KycChecklistResponse,
  EmployeeDocumentItem,
  AdminEmployee,
} from '../lib/types';

export default function DocumentVaultPanel() {
  const [activeTab, setActiveTab] = useState<'queue' | 'kyc' | 'explorer'>('queue');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [documentTypes, setDocumentTypes] = useState<DocumentTypeOption[]>([]);
  const [pendingDocs, setPendingDocs] = useState<PendingVerificationDoc[]>([]);
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');

  // Explorer Tab State
  const [employeeDocs, setEmployeeDocs] = useState<EmployeeDocumentItem[]>([]);
  const [explorerKyc, setExplorerKyc] = useState<KycChecklistResponse | null>(null);

  // Modals & Action States
  const [rejectingDocId, setRejectingDocId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  // Upload Modal State
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [uploadEmployeeId, setUploadEmployeeId] = useState('');
  const [uploadTypeId, setUploadTypeId] = useState('cv_resume');
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadEffectiveDate, setUploadEffectiveDate] = useState('');
  const [uploadExpiryDate, setUploadExpiryDate] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  // KYC Detail Modal
  const [kycDetailModal, setKycDetailModal] = useState<KycChecklistResponse | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [typesRes, pendingRes, employeesRes] = await Promise.all([
        api.documentTypes(),
        api.pendingDocuments(),
        api.employees(),
      ]);

      const empList = employeesRes?.employees || [];
      setDocumentTypes(typesRes.types || []);
      setPendingDocs(pendingRes.pendingDocuments || []);
      setEmployees(empList);

      if (empList.length > 0 && !selectedEmployeeId) {
        setSelectedEmployeeId(empList[0].id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load document vault data.');
    } finally {
      setLoading(false);
    }
  }, [selectedEmployeeId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load employee specific documents when selectedEmployeeId changes
  const loadEmployeeVault = useCallback(async (empId: string) => {
    if (!empId) return;
    try {
      const [docsRes, kycRes] = await Promise.all([
        api.employeeDocuments(empId),
        api.employeeKycChecklist(empId),
      ]);
      setEmployeeDocs(docsRes.documents || []);
      setExplorerKyc(kycRes);
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    if (selectedEmployeeId) {
      loadEmployeeVault(selectedEmployeeId);
    }
  }, [selectedEmployeeId, loadEmployeeVault]);

  const handleVerify = async (docId: string) => {
    try {
      setActionLoading(true);
      await api.verifyDocument(docId);
      await loadData();
      if (selectedEmployeeId) loadEmployeeVault(selectedEmployeeId);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!rejectingDocId || !rejectionReason.trim()) {
      alert('Please provide a reason explaining what needs correction.');
      return;
    }
    try {
      setActionLoading(true);
      await api.rejectDocument(rejectingDocId, rejectionReason.trim());
      setRejectingDocId(null);
      setRejectionReason('');
      await loadData();
      if (selectedEmployeeId) loadEmployeeVault(selectedEmployeeId);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Rejection failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDownload = async (docId: string) => {
    try {
      const res = await api.documentDownloadToken(docId);
      if (res.token) {
        window.open(`/api/documents/download/${res.token}`, '_blank');
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not generate download link.');
    }
  };

  const handleDelete = async (documentId: string, title?: string) => {
    if (!confirm(`Are you sure you want to permanently delete "${title || 'this document'}"? This removes the file from cloud and local storage.`)) {
      return;
    }
    try {
      setActionLoading(true);
      await api.deleteDocument(documentId);
      await loadData();
      if (selectedEmployeeId) {
        loadEmployeeVault(selectedEmployeeId);
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to delete document');
    } finally {
      setActionLoading(false);
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFile) {
      alert('Please select a file to upload.');
      return;
    }
    if (!uploadEmployeeId) {
      alert('Please select an employee.');
      return;
    }

    try {
      setActionLoading(true);
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('documentTypeId', uploadTypeId);
      if (uploadTitle) formData.append('title', uploadTitle);
      if (uploadEffectiveDate) formData.append('effectiveDate', uploadEffectiveDate);
      if (uploadExpiryDate) formData.append('expiryDate', uploadExpiryDate);

      await api.uploadDocument(uploadEmployeeId, formData);
      setIsUploadOpen(false);
      setUploadFile(null);
      setUploadTitle('');
      setUploadEffectiveDate('');
      setUploadExpiryDate('');
      await loadData();
      if (selectedEmployeeId === uploadEmployeeId) {
        loadEmployeeVault(uploadEmployeeId);
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setActionLoading(false);
    }
  };

  const openKycModal = async (empId: string) => {
    try {
      const kyc = await api.employeeKycChecklist(empId);
      setKycDetailModal(kyc);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to load KYC details');
    }
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-white shadow-xl space-y-6">
      {/* Header & KPI Summary */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <span className="text-2xl">📁</span>
            <h2 className="text-xl font-bold text-slate-100">Document Vault & Staff KYC Repository</h2>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800/60">
              ☁️ Supabase Cloud Storage
            </span>
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Maintain complete staff KYC records (CV, CNIC, Next of Kin, Utility Bills, Degrees) with verification workflows and expiring document alerts.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              setUploadEmployeeId(selectedEmployeeId || (employees[0]?.id || ''));
              setIsUploadOpen(true);
            }}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition flex items-center gap-2 shadow-lg shadow-indigo-600/20"
          >
            <span>+ Upload Document</span>
          </button>
          <button
            onClick={loadData}
            disabled={loading}
            className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition"
          >
            {loading ? 'Refreshing...' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Pending Verification</div>
          <div className="text-2xl font-extrabold text-amber-400 mt-1">{pendingDocs.length}</div>
          <div className="text-xs text-slate-500 mt-0.5">Submissions awaiting review</div>
        </div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Active Staff</div>
          <div className="text-2xl font-extrabold text-slate-200 mt-1">{employees.length}</div>
          <div className="text-xs text-slate-500 mt-0.5">Tracked personnel files</div>
        </div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Document Categories</div>
          <div className="text-2xl font-extrabold text-emerald-400 mt-1">{documentTypes.length}</div>
          <div className="text-xs text-slate-500 mt-0.5">Standard KYC & HR types</div>
        </div>
        <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Storage Engine</div>
          <div className="text-lg font-bold text-sky-400 mt-1 flex items-center gap-1.5">
            <span>⚡ AWS / Supabase</span>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">Private encrypted bucket</div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveTab('queue')}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition flex items-center gap-2 ${
            activeTab === 'queue'
              ? 'bg-indigo-600 text-white shadow-lg'
              : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          <span>⏳ Verification Queue</span>
          {pendingDocs.length > 0 && (
            <span className="px-2 py-0.5 text-xs bg-amber-500 text-black font-bold rounded-full">
              {pendingDocs.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('kyc')}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition flex items-center gap-2 ${
            activeTab === 'kyc'
              ? 'bg-indigo-600 text-white shadow-lg'
              : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          <span>🪪 Staff KYC Matrix</span>
        </button>

        <button
          onClick={() => setActiveTab('explorer')}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition flex items-center gap-2 ${
            activeTab === 'explorer'
              ? 'bg-indigo-600 text-white shadow-lg'
              : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          <span>📂 Document Vault Explorer</span>
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-950/60 border border-red-800 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* TAB 1: PENDING VERIFICATION QUEUE */}
      {activeTab === 'queue' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-200">
              Staff Submissions Pending Verification
            </h3>
            <span className="text-xs text-slate-400">
              Review and approve employee-uploaded identity, bills, and certificates
            </span>
          </div>

          {pendingDocs.length === 0 ? (
            <div className="p-8 text-center bg-slate-950/40 border border-slate-800 rounded-lg">
              <span className="text-3xl">🎉</span>
              <p className="text-slate-300 font-medium mt-2">All submissions verified!</p>
              <p className="text-xs text-slate-500 mt-1">No documents are currently awaiting HR review.</p>
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-800 rounded-lg">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-950/80 text-xs uppercase text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3">Employee</th>
                    <th className="px-4 py-3">Document Category</th>
                    <th className="px-4 py-3">Title & File</th>
                    <th className="px-4 py-3">Size & Provider</th>
                    <th className="px-4 py-3">Uploaded At</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-900/40">
                  {pendingDocs.map((doc) => (
                    <tr key={doc.id} className="hover:bg-slate-800/50 transition">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-white">{doc.employeeName}</div>
                        <div className="text-xs text-slate-400">{doc.employeeRole || 'Employee'}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-indigo-950 text-indigo-300 border border-indigo-800/60">
                          {doc.documentTypeName}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-200">{doc.title}</div>
                        <div className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
                          <span>📎 {doc.filename}</span>
                          <button
                            onClick={() => handleDownload(doc.id)}
                            className="text-xs text-indigo-400 hover:text-indigo-300 underline font-medium"
                          >
                            Preview
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">
                        <div>{formatBytes(doc.sizeBytes)}</div>
                        <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300">
                          {doc.storageProvider}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">{doc.uploadedAt}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleVerify(doc.id)}
                            disabled={actionLoading}
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-bold transition shadow-sm"
                          >
                            ✓ Verify
                          </button>
                          <button
                            onClick={() => {
                              setRejectingDocId(doc.id);
                              setRejectionReason('');
                            }}
                            disabled={actionLoading}
                            className="px-3 py-1.5 bg-rose-600/80 hover:bg-rose-600 text-white rounded text-xs font-bold transition shadow-sm"
                          >
                            ✕ Reject
                          </button>
                          <button
                            onClick={() => handleDelete(doc.id, doc.title)}
                            disabled={actionLoading}
                            className="px-2.5 py-1.5 bg-slate-800 hover:bg-rose-900/60 text-slate-400 hover:text-rose-300 rounded text-xs font-bold transition border border-slate-700 hover:border-rose-700/50"
                            title="Delete document"
                          >
                            🗑️
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: STAFF KYC MATRIX */}
      {activeTab === 'kyc' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-200">
              Workforce KYC & Onboarding Compliance
            </h3>
            <span className="text-xs text-slate-400">
              Track mandatory compliance requirements across all staff
            </span>
          </div>

          <div className="overflow-x-auto border border-slate-800 rounded-lg">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="bg-slate-950/80 text-xs uppercase text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3 text-center">Compliance Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-900/40">
                {employees.map((emp) => (
                  <tr key={emp.id} className="hover:bg-slate-800/50 transition">
                    <td className="px-4 py-3 font-semibold text-white">{emp.name}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{emp.role}</td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => openKycModal(emp.id)}
                        className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-indigo-300 rounded-md border border-slate-700 transition"
                      >
                        Inspect KYC Checklist →
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => {
                          setSelectedEmployeeId(emp.id);
                          setActiveTab('explorer');
                        }}
                        className="px-3 py-1 bg-indigo-600/80 hover:bg-indigo-600 text-white rounded text-xs font-semibold transition"
                      >
                        Open Vault
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: DOCUMENT VAULT EXPLORER */}
      {activeTab === 'explorer' && (
        <div className="space-y-5">
          {/* Employee Selector Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-950/70 p-4 rounded-lg border border-slate-800">
            <div className="flex items-center gap-3">
              <label className="text-sm font-semibold text-slate-300">Selected Employee:</label>
              <select
                value={selectedEmployeeId}
                onChange={(e) => setSelectedEmployeeId(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 font-medium"
              >
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name} ({emp.role})
                  </option>
                ))}
              </select>
            </div>

            {explorerKyc && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400">KYC Progress:</span>
                <div className="w-32 bg-slate-800 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="bg-emerald-500 h-2.5 rounded-full transition-all"
                    style={{ width: `${explorerKyc.completionPercentage}%` }}
                  ></div>
                </div>
                <span className="text-xs font-bold text-emerald-400">
                  {explorerKyc.completionPercentage}%
                </span>
              </div>
            )}
          </div>

          {/* Explorer Documents Table */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-200">
                Personnel Documents for {employees.find((e) => e.id === selectedEmployeeId)?.name || 'Employee'}
              </h3>
              <span className="text-xs text-slate-400">
                {employeeDocs.length} active documents in cloud vault
              </span>
            </div>

            {employeeDocs.length === 0 ? (
              <div className="p-8 text-center bg-slate-950/40 border border-slate-800 rounded-lg">
                <span className="text-3xl">📂</span>
                <p className="text-slate-300 font-medium mt-2">No documents uploaded yet</p>
                <p className="text-xs text-slate-500 mt-1">
                  Upload employee CV, NIC card, contract, or utility bill using the button above.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-800 rounded-lg">
                <table className="w-full text-left text-sm text-slate-300">
                  <thead className="bg-slate-950/80 text-xs uppercase text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3">Title & File</th>
                      <th className="px-4 py-3">Version & Size</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Expiry Date</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-900/40">
                    {employeeDocs.map((doc) => (
                      <tr key={doc.id} className="hover:bg-slate-800/50 transition">
                        <td className="px-4 py-3">
                          <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-indigo-950 text-indigo-300 border border-indigo-800/60">
                            {doc.type}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-200">{doc.title}</div>
                          <div className="text-xs text-slate-400 mt-0.5">📎 {doc.filename || 'File'}</div>
                          {doc.rejectionReason && (
                            <div className="text-xs text-rose-400 mt-1 bg-rose-950/40 p-1.5 rounded border border-rose-900/50">
                              ⚠️ Feedback: {doc.rejectionReason}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400">
                          <div className="font-semibold text-slate-300">v{doc.version}</div>
                          <div>{formatBytes(doc.sizeBytes)} · {doc.storageProvider}</div>
                        </td>
                        <td className="px-4 py-3">
                          {doc.verificationStatus === 'VERIFIED' && (
                            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800/60">
                              ✓ Verified
                            </span>
                          )}
                          {doc.verificationStatus === 'PENDING_VERIFICATION' && (
                            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-950 text-amber-400 border border-amber-800/60">
                              ⏳ Pending Review
                            </span>
                          )}
                          {doc.verificationStatus === 'REJECTED' && (
                            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-rose-950 text-rose-400 border border-rose-800/60">
                              ✕ Rejected
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400">
                          {doc.expiryDate ? doc.expiryDate : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleDownload(doc.id)}
                              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium transition"
                            >
                              Download
                            </button>
                            {doc.verificationStatus === 'PENDING_VERIFICATION' && (
                              <button
                                onClick={() => handleVerify(doc.id)}
                                className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-bold transition"
                                title="Verify document"
                              >
                                ✓
                              </button>
                            )}
                            <button
                              onClick={() => handleDelete(doc.id, doc.title)}
                              className="px-2.5 py-1.5 bg-slate-800 hover:bg-rose-900/60 text-slate-400 hover:text-rose-300 rounded text-xs font-bold transition border border-slate-700 hover:border-rose-700/50"
                              title="Delete document"
                            >
                              🗑️
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL 1: REJECT DOCUMENT WITH FEEDBACK */}
      {rejectingDocId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="text-rose-400">✕</span> Reject Document Submission
            </h3>
            <p className="text-xs text-slate-400">
              Provide specific feedback explaining why this document cannot be verified (e.g. blurry image, utility bill expired, missing back side of CNIC). The employee will receive this feedback on their mobile app to re-upload.
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Rejection Reason / Required Correction <span className="text-rose-400">*</span>
              </label>
              <textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="e.g. Utility bill must be dated within the last 3 months. Please upload a recent bill."
                rows={3}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-rose-500"
              />
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setRejectingDocId(null)}
                disabled={actionLoading}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm transition"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={actionLoading || !rejectionReason.trim()}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-sm font-bold transition shadow-lg disabled:opacity-50"
              >
                {actionLoading ? 'Rejecting...' : 'Confirm Rejection'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: UPLOAD DOCUMENT */}
      {isUploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <span>📁</span> Upload Document to Vault
              </h3>
              <button
                onClick={() => setIsUploadOpen(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleUploadSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Employee <span className="text-rose-400">*</span>
                </label>
                <select
                  value={uploadEmployeeId}
                  onChange={(e) => setUploadEmployeeId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  required
                >
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} ({emp.role})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Document Category <span className="text-rose-400">*</span>
                </label>
                <select
                  value={uploadTypeId}
                  onChange={(e) => setUploadTypeId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  required
                >
                  {documentTypes.map((dt) => (
                    <option key={dt.id} value={dt.id}>
                      {dt.name} ({dt.confidentiality})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Document Title / Description
                </label>
                <input
                  type="text"
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  placeholder="e.g. Signed Employment Contract 2026"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Effective Date
                  </label>
                  <input
                    type="date"
                    value={uploadEffectiveDate}
                    onChange={(e) => setUploadEffectiveDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Expiry Date (if applicable)
                  </label>
                  <input
                    type="date"
                    value={uploadExpiryDate}
                    onChange={(e) => setUploadExpiryDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Select File (PDF, PNG, JPG) <span className="text-rose-400">*</span>
                </label>
                <input
                  type="file"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-300 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-indigo-600 file:text-white hover:file:bg-indigo-500"
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsUploadOpen(false)}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold transition shadow-lg"
                >
                  {actionLoading ? 'Uploading to Supabase...' : 'Upload File'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: KYC CHECKLIST INSPECTOR */}
      {kycDetailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-2xl w-full p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <span>🪪</span> KYC Checklist: {kycDetailModal.employeeName}
                </h3>
                <span className="text-xs text-slate-400">
                  Role: {kycDetailModal.employeeRole} · Completion: {kycDetailModal.completionPercentage}%
                </span>
              </div>
              <button
                onClick={() => setKycDetailModal(null)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider">
                Mandatory Personnel Documents
              </h4>
              <div className="space-y-2">
                {kycDetailModal.mandatoryChecklist.map((item) => (
                  <div
                    key={item.typeId}
                    className="p-3 bg-slate-950/60 border border-slate-800 rounded-lg flex items-center justify-between gap-4"
                  >
                    <div>
                      <div className="font-semibold text-slate-200 text-sm">{item.name}</div>
                      <div className="text-xs text-slate-400">{item.description}</div>
                      {item.filename && (
                        <div className="text-xs text-indigo-400 mt-0.5">📎 {item.filename}</div>
                      )}
                      {item.rejectionReason && (
                        <div className="text-xs text-rose-400 mt-1">⚠️ {item.rejectionReason}</div>
                      )}
                    </div>
                    <div>
                      {item.status === 'VERIFIED' && (
                        <span className="px-2.5 py-1 rounded text-xs font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
                          ✓ Verified
                        </span>
                      )}
                      {item.status === 'PENDING_VERIFICATION' && (
                        <span className="px-2.5 py-1 rounded text-xs font-bold bg-amber-950 text-amber-400 border border-amber-800">
                          ⏳ Pending Review
                        </span>
                      )}
                      {item.status === 'REJECTED' && (
                        <span className="px-2.5 py-1 rounded text-xs font-bold bg-rose-950 text-rose-400 border border-rose-800">
                          ✕ Rejected
                        </span>
                      )}
                      {item.status === 'MISSING' && (
                        <span className="px-2.5 py-1 rounded text-xs font-bold bg-slate-800 text-slate-400">
                          Missing
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-800">
              <button
                onClick={() => setKycDetailModal(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
