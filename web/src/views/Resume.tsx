/**
 * The resume view.
 *
 * Two jobs: get a resume in, and let the person correct what was read out of
 * it. The correction UI is not an afterthought — a parser will always get some
 * things wrong, and if the person cannot fix them here, every fill downstream
 * is wrong too.
 *
 * Layout: upload zone at the top when empty; otherwise a parsed-facts summary,
 * grouped exactly as a resume is (identity, education, experience), with each
 * value editable in place.
 */

import { useCallback, useMemo, useRef, useState, type JSX } from "react";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_SETTINGS,
  PROJECT_CATEGORIES,
  PROJECT_CATEGORY_LABELS,
  customModelReady,
  experienceKindOf,
  formatRange,
  maskValue,
  profileFromModelDraft,
  summarizeProfile,
  type Education,
  type Experience,
  type Profile,
  type ProfileChange,
  type Project,
  type ProjectCategory,
  type ReparseMode,
  type ReparsePreview,
} from "@quill/core";
import { useWorkbench } from "../state.js";
import { getStore } from "../data/store.js";
import {
  ACCEPTED_TYPES,
  ACCEPTED_TYPES_WITH_IMAGES,
  extractText,
  validateFile,
} from "../data/extract.js";
import {
  extractFileWithModel,
  extractTextWithModel,
  type ModelResumeResult,
} from "../data/model.js";
import { extractResumeWithUserModel } from "../data/userModel.js";
import { relativeTime } from "../data/format.js";
import {
  Book,
  CheckCircle,
  Document,
  Info,
  Plus,
  Sparkle,
  Trash,
  Upload,
  Warning,
  X,
} from "../icons.js";

type Toast = (text: string, tone?: "neutral" | "success" | "error") => void;

export function ResumeView({
  onNavigate,
  onToast,
}: {
  onNavigate: (route: string) => void;
  onToast: Toast;
}): JSX.Element {
  const { state, reload, patch, updateSettings } = useWorkbench();
  const [importing, setImporting] = useState(false);
  const [reparsing, setReparsing] = useState(false);
  const [reparsePreview, setReparsePreview] = useState<ReparsePreview | undefined>();
  const [confirmUpload, setConfirmUpload] = useState(false);
  const [importError, setImportError] = useState<string | undefined>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<File | undefined>();
  const [creatingDirection, setCreatingDirection] = useState(false);
  const [directionName, setDirectionName] = useState("");
  const [renamingDirection, setRenamingDirection] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteDirectionConfirm, setDeleteDirectionConfirm] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const profile = state.profile;
  const activeDossier = state.profiles.find((dossier) => dossier.id === state.activeProfileId);
  const resumeModel = state.settings?.resumeModel ?? DEFAULT_SETTINGS.resumeModel;
  const customModel = state.settings?.model ?? DEFAULT_MODEL_CONFIG;
  const userModelReady = customModelReady(customModel);
  const networkModel = resumeModel.enabled || userModelReady;
  const modelDestination = [
    userModelReady ? `自定义模型 ${serverHost(customModel.baseUrl)}` : "",
    resumeModel.enabled ? `识别服务器 ${serverHost(resumeModel.baseUrl)}` : "",
  ]
    .filter(Boolean)
    .join(" 或 ");
  const accept = resumeModel.enabled ? ACCEPTED_TYPES_WITH_IMAGES : ACCEPTED_TYPES;
  const sourceDocument = state.documents.find((document) => document.id === profile?.sourceDocumentId);
  const visibleWarnings = [
    ...new Set([...(reparsePreview?.parseWarnings ?? profile?.parseWarnings ?? []), ...warnings]),
  ];
  const hasResumeData = Boolean(
    profile &&
      (profile.sourceDocumentId ||
        profile.rawText?.trim() ||
        profile.identity.fullName ||
        profile.contact.email ||
        profile.contact.phone ||
        profile.education.length > 0 ||
        profile.experience.length > 0 ||
        profile.projects.length > 0 ||
        profile.skills.items.length > 0 ||
        profile.preference.position),
  );

  /* ------------------------------------------------------------- import */

  /**
   * Model first, local rules second.
   *
   * A failure anywhere in the model path falls through to the local parser
   * instead of aborting the import, and the warning says which path produced
   * the profile. A scan or image has no local path; there the fallback error
   * explains that the file needs OCR.
   */
  const runImport = useCallback(
    async (file: File, useModel: boolean) => {
      setImporting(true);
      setImportError(undefined);
      setWarnings([]);
      let modelFailure: string | undefined;

      try {
        if (useModel) {
          let saved = false;
          try {
            const lower = file.name.toLowerCase();
            const isPdf = lower.endsWith(".pdf") || file.type === "application/pdf";
            const isImage =
              file.type === "image/png" ||
              file.type === "image/jpeg" ||
              /\.(png|jpe?g)$/i.test(lower);

            let result: ModelResumeResult;
            let localWarnings: string[] = [];
            let usedCustom = false;

            if (isImage) {
              if (!resumeModel.enabled) {
                throw new Error(
                  "图片和扫描件需要 Quill 识别服务；自定义模型只能读取可复制文字的 PDF、DOCX 和 TXT。",
                );
              }
              result = await extractFileWithModel(file, resumeModel.baseUrl, resumeModel.betaCode);
            } else if (userModelReady) {
              /*
               * The person's own endpoint reads text, not files. Extract the
               * text locally first so the request carries no more than the
               * resume text itself, and so a scanned PDF can still be routed
               * to Quill's OCR server when that is also configured.
               */
              let extractedText = "";
              try {
                const extracted = await extractText(file);
                localWarnings = extracted.warnings;
                extractedText = extracted.text;
              } catch (error) {
                // A malformed PDF may still be readable by the server's
                // renderer; anything else has no fallback and should surface.
                if (!isPdf || !resumeModel.enabled) throw error;
              }

              if (extractedText.trim().length >= 80) {
                result = await extractResumeWithUserModel(extractedText, customModel);
                usedCustom = true;
              } else if (isPdf && resumeModel.enabled) {
                result = await extractFileWithModel(file, resumeModel.baseUrl, resumeModel.betaCode);
              } else if (isPdf) {
                throw new Error(
                  "这份 PDF 没有可复制的文字，可能是扫描件。自定义模型不能 OCR；请在设置里连接 Quill 识别服务，或换一份可复制文字的简历。",
                );
              } else {
                throw new Error("这份文件里没有可读取的文字。");
              }
            } else if (isPdf) {
              result = await extractFileWithModel(file, resumeModel.baseUrl, resumeModel.betaCode);
            } else {
              // Word and text files are read locally, then only their text is
              // uploaded. There is no reason to ship the container format.
              const extracted = await extractText(file);
              if (!extracted.text.trim()) throw new Error("这份文件里没有可读取的文字。");
              localWarnings = extracted.warnings;
              result = await extractTextWithModel(
                extracted.text,
                file.name,
                resumeModel.baseUrl,
                resumeModel.betaCode,
              );
            }

            const nextProfile = profileFromModelDraft(result.draft, {
              rawText: result.text,
              warnings: result.warnings,
            });

            await getStore().importDocument({
              kind: "resume",
              fileName: file.name,
              mimeType: file.type || "application/octet-stream",
              text: result.text,
              extractionMethod: "model",
              profile: nextProfile,
            });
            saved = true;
            await reload();
            setWarnings([...localWarnings, ...result.warnings]);
            onToast(
              usedCustom ? `已用自定义模型识别 ${file.name}` : `已用模型识别 ${file.name}`,
              "success",
            );
            return;
          } catch (error) {
            /*
             * Once the profile is saved, a later failure (usually the refresh)
             * must not fall through to a local parse that replaces it.
             */
            if (saved) {
              setImportError(
                error instanceof Error
                  ? `简历已识别并保存，但刷新资料失败：${error.message}`
                  : "简历已识别并保存，但刷新资料失败。",
              );
              return;
            }
            modelFailure = error instanceof Error ? error.message : "未知错误";
          }
        }

        const extracted = await extractText(file);
        if (!extracted.text.trim()) {
          throw new Error("这份文件里没有可读取的文字，可能是扫描件。");
        }

        await getStore().importDocument({
          kind: "resume",
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          text: extracted.text,
          extractionMethod: "local",
        });
        await reload();
        setWarnings([
          ...(modelFailure
            ? [`模型识别没有完成（${modelFailure}），已改用本地规则解析，请仔细核对。`]
            : []),
          ...extracted.warnings,
        ]);
        onToast(
          modelFailure ? "模型识别未完成，已用本地规则读取" : `已读取 ${file.name}`,
          modelFailure ? "neutral" : "success",
        );
      } catch (error) {
        const localMessage = error instanceof Error ? error.message : "读取文件失败";
        setImportError(
          modelFailure ? `${localMessage} 模型识别也没有完成：${modelFailure}` : localMessage,
        );
      } finally {
        setImporting(false);
      }
    },
    [
      customModel,
      onToast,
      reload,
      resumeModel.baseUrl,
      resumeModel.betaCode,
      resumeModel.enabled,
      userModelReady,
    ],
  );

  const importFile = useCallback(
    async (file: File) => {
      const lower = file.name.toLowerCase();
      const isImage =
        file.type === "image/png" ||
        file.type === "image/jpeg" ||
        /\.(png|jpe?g)$/i.test(lower);

      if (isImage && !resumeModel.enabled) {
        setImportError(
          userModelReady
            ? "图片和扫描件需要 Quill 识别服务；自定义模型只能读取可复制文字的 PDF、DOCX 和 TXT。你可以在设置里同时连接识别服务。"
            : "图片需要开启模型识别才能读取；请先选择一个识别方式，或改用可复制文字的 PDF / DOCX。",
        );
        return;
      }

      const invalid = validateFile(file, 20, { allowImages: resumeModel.enabled });
      if (invalid) {
        setImportError(invalid);
        return;
      }
      if (networkModel && !resumeModel.consentShown) {
        setPendingUpload(file);
        setImportError(undefined);
        return;
      }
      await runImport(file, networkModel);
    },
    [networkModel, resumeModel.enabled, resumeModel.consentShown, runImport, userModelReady],
  );

  const acceptModelUpload = useCallback(async () => {
    const file = pendingUpload;
    if (!file) return;
    setPendingUpload(undefined);
    try {
      await updateSettings({ resumeModel: { ...resumeModel, consentShown: true } });
    } catch {
      // The person consented to this upload even if the preference could not
      // be persisted; do not strand the file.
    }
    await runImport(file, true);
  }, [pendingUpload, resumeModel, runImport, updateSettings]);

  const declineModelUpload = useCallback(async () => {
    const file = pendingUpload;
    if (!file) return;
    setPendingUpload(undefined);
    await runImport(file, false);
  }, [pendingUpload, runImport]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      const file = event.dataTransfer.files[0];
      if (file) void importFile(file);
    },
    [importFile],
  );

  /**
   * Rebuild the profile from the resume text already on this device.
   *
   * The preview is read-only. Nothing is written until the person chooses
   * “只补充空白” or “覆盖全部内容” in the review panel, and even then the
   * pre-reparse profile is kept as a one-deep backup.
   */
  const reviewReparse = useCallback(async () => {
    setReparsing(true);
    try {
      setReparsePreview(await getStore().previewReparse());
    } catch (error) {
      onToast(error instanceof Error ? error.message : "重新解析失败", "error");
    } finally {
      setReparsing(false);
    }
  }, [onToast]);

  const applyReparseMode = useCallback(
    async (mode: ReparseMode) => {
      setReparsing(true);
      try {
        await getStore().reparseResume(mode);
        await reload();
        setReparsePreview(undefined);
        onToast(
          mode === "merge" ? "已补充新识别出的内容，原有填写保持不变" : "已按新的解析结果覆盖当前方向",
          "success",
        );
      } catch (error) {
        onToast(error instanceof Error ? error.message : "重新解析失败", "error");
      } finally {
        setReparsing(false);
      }
    },
    [onToast, reload],
  );

  const undoReparse = useCallback(async () => {
    setReparsing(true);
    try {
      await getStore().undoReparse();
      await reload();
      onToast("已恢复到上次替换前的资料", "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "撤销失败", "error");
    } finally {
      setReparsing(false);
    }
  }, [onToast, reload]);

  /* --------------------------------------------------------------- edit */

  /**
   * Edits write the whole profile back. It is a small object (a few KB), and
   * re-sending it keeps the store's API at one method instead of a dozen
   * field-level mutators.
   */
  const updateProfile = useCallback(
    async (mutate: (draft: Profile) => void) => {
      if (!profile) return;
      const draft = structuredClone(profile);
      mutate(draft);
      const saved = await getStore().saveProfile(draft);
      patch({ profile: saved });
    },
    [patch, profile],
  );

  /* ---------------------------------------------------------- directions */

  const switchDirection = useCallback(
    async (id: string) => {
      if (id === state.activeProfileId) return;
      try {
        await getStore().switchProfile(id);
        await reload();
        setReparsePreview(undefined);
        setDeleteDirectionConfirm(false);
        setRenamingDirection(false);
        setCreatingDirection(false);
        onToast("已切换到该方向", "success");
      } catch (error) {
        onToast(error instanceof Error ? error.message : "切换方向失败", "error");
      }
    },
    [onToast, reload, state.activeProfileId],
  );

  const createDirection = useCallback(async () => {
    const name = directionName.trim();
    if (!name) return;
    try {
      await getStore().createProfile(name);
      await reload();
      setDirectionName("");
      setCreatingDirection(false);
      setReparsePreview(undefined);
      onToast("已新建空白方向，请上传这份方向专用的简历", "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "新建方向失败", "error");
    }
  }, [directionName, onToast, reload]);

  const renameDirection = useCallback(async () => {
    if (!state.activeProfileId) return;
    const name = renameDraft.trim();
    if (!name) return;
    try {
      await getStore().renameProfile(state.activeProfileId, name);
      await reload();
      setRenamingDirection(false);
      onToast("已重命名当前方向", "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "重命名失败", "error");
    }
  }, [onToast, reload, renameDraft, state.activeProfileId]);

  const deleteDirection = useCallback(async () => {
    if (!state.activeProfileId) return;
    try {
      await getStore().deleteProfile(state.activeProfileId);
      await reload();
      setDeleteDirectionConfirm(false);
      setRenamingDirection(false);
      setReparsePreview(undefined);
      onToast("已删除该方向档案", "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "删除方向失败", "error");
    }
  }, [onToast, reload, state.activeProfileId]);

  const summary = useMemo(() => (profile ? summarizeProfile(profile) : []), [profile]);

  /* --------------------------------------------------------------- render */

  if (!profile || !hasResumeData) {
    return (
      <div className="q-page">
        <header className="q-page-head q-reveal">
          <h1 className="q-page-title">
            {activeDossier ? `为「${activeDossier.name}」方向上传专属简历` : "上传一份简历，建立你的资料库。"}
          </h1>
          <p className="q-page-lead">
            {activeDossier
              ? "每个求职方向单独保存一份简历。上传后，这份简历只属于当前方向；投递时扩展会结合岗位页面信息和已分析的匹配岗位，自动选择最相关的方向简历。"
              : "Quill 会读取其中的姓名、联系方式、教育与工作经历，形成结构化资料。投递时会根据岗位信息自动选择最相关的方向简历。"}
          </p>
        </header>

        <Dropzone
          active={dragActive}
          busy={importing}
          images={resumeModel.enabled}
          onSelect={() => inputRef.current?.click()}
          onDrop={onDrop}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
        />

        {state.profiles.length > 1 && (
          <section className="q-block" style={{ marginTop: "var(--s-5)" }}>
            <SectionHead title="其他方向简历" sub="切换方向后，可以上传或查看那份方向专用简历。" />
            <div className="q-direction-list">
              {state.profiles.map((dossier) => (
                <button
                  key={dossier.id}
                  type="button"
                  className="q-direction-chip"
                  data-active={dossier.id === state.activeProfileId}
                  aria-pressed={dossier.id === state.activeProfileId}
                  onClick={() => void switchDirection(dossier.id)}
                >
                  <span className="q-direction-name">{dossier.name}</span>
                  <span className="q-cap">
                    {dossier.position || `${dossier.educationCount} 段教育 · ${dossier.experienceCount} 段经历`}
                  </span>
                </button>
              ))}
            </div>
            {activeDossier && state.profiles.length > 1 && (
              <div className="q-toolbar" style={{ marginTop: "var(--s-3)" }}>
                <button
                  type="button"
                  className="q-btn q-btn-danger q-btn-sm"
                  onClick={() => setDeleteDirectionConfirm(true)}
                >
                  <Trash size={14} />
                  删除这个空白方向
                </button>
              </div>
            )}
          </section>
        )}

        {deleteDirectionConfirm && activeDossier && (
          <div className="q-insight" data-kind="warning" role="alertdialog" style={{ marginTop: "var(--s-4)" }}>
            <Warning size={16} />
            <div className="q-grow">
              <div className="q-insight-title">删除空白方向「{activeDossier.name}」？</div>
              <div className="q-insight-detail">这个方向档案会被删除，其他方向的简历不受影响。</div>
              <div className="q-toolbar" style={{ marginTop: "var(--s-3)" }}>
                <button type="button" className="q-btn q-btn-ghost q-btn-sm" onClick={() => setDeleteDirectionConfirm(false)}>
                  保留
                </button>
                <button
                  type="button"
                  className="q-btn q-btn-primary q-btn-sm"
                  style={{ background: "var(--red)" }}
                  onClick={() => void deleteDirection()}
                >
                  删除方向
                </button>
              </div>
            </div>
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={accept}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
            event.target.value = "";
          }}
        />

        {importError && (
          <div className="q-insight" data-kind="warning" style={{ marginTop: "var(--s-4)" }}>
            <Warning size={16} />
            <div>
              <div className="q-insight-title">无法读取这个文件</div>
              <div className="q-insight-detail">{importError}</div>
            </div>
          </div>
        )}

        {pendingUpload && (
          <ModelConsent
            file={pendingUpload}
            destination={modelDestination}
            onCancel={() => setPendingUpload(undefined)}
            onLocal={() => void declineModelUpload()}
            onModel={() => void acceptModelUpload()}
          />
        )}

        <div className="q-consent" style={{ marginTop: "var(--s-8)" }}>
          <InfoIcon />
          <div>
            {resumeModel.enabled && userModelReady ? (
              <>
                新上传简历的可复制文字会发送到你配置的自定义模型 {serverHost(customModel.baseUrl)}；
                图片和扫描件会发送到识别服务器 {serverHost(resumeModel.baseUrl)}。
                其余数据只保存在这台设备，你可以随时在设置里关闭模型识别。
              </>
            ) : resumeModel.enabled ? (
              <>
                模型识别已开启：新上传简历的文字会发送到识别服务器 {serverHost(resumeModel.baseUrl)}
                ，由它转写并结构化。服务器不保存文件或结果，其余数据仍只保存在这台设备；你可以随时在设置里关闭。
              </>
            ) : userModelReady ? (
              <>
                新上传简历的文字会发送到你配置的自定义模型 {serverHost(customModel.baseUrl)}
                做结构化，图片和扫描件暂不支持。API Key 只保存在本机，Quill 的服务器看不到它。
              </>
            ) : (
              <>
                简历文件本身不会离开这台设备：Quill 只在本机提取其中的文字，并把文字保存在浏览器存储里，
                不上传到任何服务器。你可以随时在设置里删除。
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="q-page">
      <header className="q-page-head q-reveal">
        <div className="q-between" style={{ alignItems: "flex-start", gap: "var(--s-4)", flexWrap: "wrap" }}>
          <div>
            <h1 className="q-page-title">
              {profile.identity.fullName ? profile.identity.fullName : "你的资料"}
            </h1>
            <p className="q-page-lead">
              {activeDossier ? `当前编辑「${activeDossier.name}」方向简历。` : ""}
              这些是从这份简历中读到的内容。有读错的地方直接改；投递时扩展会自动匹配最相关的方向简历。
            </p>
            {sourceDocument?.extractionMethod && (
              <p className="q-block-sub" style={{ marginTop: "var(--s-2)" }}>
                <span
                  className={`q-chip ${
                    sourceDocument.extractionMethod === "model" ? "q-chip-green" : "q-chip-neutral"
                  }`}
                >
                  {sourceDocument.extractionMethod === "model" ? "模型识别" : "本地规则解析"}
                </span>
                <span style={{ marginLeft: "var(--s-2)" }}>
                  {sourceDocument.extractionMethod === "model"
                    ? "由识别服务器转写并结构化，请核对关键字段。"
                    : "只在这台设备上解析，扫描件与图片未能读取。"}
                </span>
              </p>
            )}
          </div>
          <div className="q-toolbar">
            {state.reparseBackup && (
              <button
                type="button"
                className="q-btn q-btn-ghost"
                disabled={reparsing || importing}
                onClick={() => void undoReparse()}
                title="恢复到上一次重新上传或重新解析之前的资料"
              >
                撤销上次替换
              </button>
            )}
            <button
              type="button"
              className="q-btn q-btn-ghost"
              disabled={reparsing || importing}
              title="先对比新解析结果，确认后才写入"
              onClick={() => void reviewReparse()}
            >
              <Sparkle size={15} />
              {reparsing ? "正在分析…" : "重新解析"}
            </button>
            <button
              type="button"
              className="q-btn q-btn-outline"
              onClick={() => {
                // Re-uploading replaces the active direction's profile too.
                // Ask explicitly rather than relying on the file picker to imply it.
                if (profile) setConfirmUpload(true);
                else inputRef.current?.click();
              }}
            >
              <Upload size={15} />
              重新上传
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFile(file);
                event.target.value = "";
              }}
            />
          </div>
        </div>
      </header>

      {pendingUpload && (
        <ModelConsent
          file={pendingUpload}
          destination={modelDestination}
          onCancel={() => setPendingUpload(undefined)}
          onLocal={() => void declineModelUpload()}
          onModel={() => void acceptModelUpload()}
        />
      )}

      {confirmUpload && (
        <section className="q-card-lg q-reparse-review" role="alertdialog" aria-labelledby="upload-replace-title">
          <div>
            <h2 className="q-block-title" id="upload-replace-title">
              重新上传会替换当前方向的资料
            </h2>
            <p className="q-block-sub">
              新文件解析后会覆盖「{activeDossier?.name ?? "当前方向"}」里的内容，包括你手动修改过的字段。
              如果想保留现有内容，请先取消，用「重新解析」查看差异后选择只补充空白。
            </p>
          </div>
          <div className="q-toolbar" style={{ marginTop: "var(--s-4)" }}>
            <button type="button" className="q-btn q-btn-ghost" onClick={() => setConfirmUpload(false)}>
              取消
            </button>
            <button
              type="button"
              className="q-btn q-btn-primary"
              style={{ background: "var(--red)" }}
              onClick={() => {
                setConfirmUpload(false);
                inputRef.current?.click();
              }}
            >
              继续选择文件
            </button>
          </div>
        </section>
      )}

      {reparsePreview && (
        <section
          className="q-card-lg q-reparse-review"
          role="alertdialog"
          aria-labelledby="reparse-review-title"
        >
          <div className="q-between" style={{ alignItems: "flex-start", gap: "var(--s-4)", flexWrap: "wrap" }}>
            <div>
              <h2 className="q-block-title" id="reparse-review-title">
                替换前请确认
              </h2>
              <p className="q-block-sub">
                新解析结果与当前资料有 {reparsePreview.total} 处不同。这里只做了对比，还没有写入任何内容。
              </p>
            </div>
            <span className="q-chip q-chip-neutral">{reparsePreview.sourceChars.toLocaleString()} 字原文</span>
          </div>

          <div className="q-reparse-tally">
            <span className="q-chip q-chip-red">会丢失 {reparsePreview.losses} 处</span>
            <span className="q-chip q-chip-orange">会覆盖 {reparsePreview.overwrites} 处</span>
            <span className="q-chip q-chip-green">可补充 {reparsePreview.added} 处</span>
          </div>

          <p className="q-block-sub">
            「只补充空白」不会改动任何已经填写或修改过的内容；「覆盖全部内容」会以新解析结果为准。
            无论选哪一种，都可以在完成后用「撤销上次替换」恢复。
          </p>

          {reparsePreview.parseWarnings.length > 0 && (
            <div className="q-insight" data-kind="warning" style={{ marginBottom: "var(--s-5)" }}>
              <Warning size={16} />
              <div>
                <div className="q-insight-title">本次解析提醒</div>
                <ul style={{ marginTop: "var(--s-2)", display: "flex", flexDirection: "column", gap: "0.1875rem" }}>
                  {reparsePreview.parseWarnings.map((warning, index) => (
                    <li key={index} className="q-insight-detail">
                      {warning}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {reparsePreview.changes.length > 0 ? (
            <div className="q-reparse-changes">
              {reparsePreview.changes.slice(0, 12).map((change) => (
                <div className="q-reparse-change" key={change.path} data-kind={change.kind}>
                  <span
                    className={`q-chip ${
                      change.kind === "removed"
                        ? "q-chip-red"
                        : change.kind === "changed"
                          ? "q-chip-orange"
                          : "q-chip-green"
                    }`}
                  >
                    {change.kind === "removed" ? "丢失" : change.kind === "changed" ? "变化" : "补充"}
                  </span>
                  <div className="q-grow">
                    <div className="q-strong">{change.label}</div>
                    <div className="q-reparse-values">
                      {change.previous !== undefined && (
                        <span className="q-reparse-old">{previewValue(change, "previous")}</span>
                      )}
                      {change.kind === "changed" && <span className="q-reparse-arrow">→</span>}
                      {change.next !== undefined && (
                        <span className="q-reparse-new">{previewValue(change, "next")}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {reparsePreview.changes.length > 12 && (
                <p className="q-cap">还有 {reparsePreview.changes.length - 12} 处差异未展开。</p>
              )}
            </div>
          ) : (
            <div className="q-insight">
              <CheckCircle size={16} />
              <div>
                <div className="q-insight-title">
                  {reparsePreview.identical ? "没有发现差异" : "资料字段没有变化"}
                </div>
                <div className="q-insight-detail">
                  {reparsePreview.identical
                    ? "当前版本解析出的内容和提醒都与已保存结果一致，不需要替换。"
                    : "字段内容未变化，但本次解析提醒有更新。核对上方提醒后，可以应用解析结果保存它们。"}
                </div>
              </div>
            </div>
          )}

          <div className="q-toolbar" style={{ marginTop: "var(--s-5)" }}>
            <button
              type="button"
              className="q-btn q-btn-ghost"
              onClick={() => setReparsePreview(undefined)}
              disabled={reparsing}
            >
              取消
            </button>
            <button
              type="button"
              className="q-btn q-btn-outline"
              onClick={() => void applyReparseMode("merge")}
              disabled={reparsing || reparsePreview.identical}
            >
              只补充空白（推荐）
            </button>
            <button
              type="button"
              className="q-btn q-btn-primary"
              style={{ background: "var(--red)" }}
              onClick={() => void applyReparseMode("replace")}
              disabled={reparsing || reparsePreview.identical}
            >
              覆盖全部内容
            </button>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------ directions */}
      <section className="q-block q-reveal">
        <SectionHead
          title="方向档案"
          sub="每个方向单独维护一份简历。工作台选中项只决定当前编辑的档案；投递时扩展会结合岗位页面信息和已分析的匹配岗位，自动选择最相关的简历。"
        />
        <div className="q-card-lg">
          <div className="q-direction-list">
            {state.profiles.map((dossier) => (
              <button
                key={dossier.id}
                type="button"
                className="q-direction-chip"
                data-active={dossier.id === state.activeProfileId}
                aria-pressed={dossier.id === state.activeProfileId}
                onClick={() => void switchDirection(dossier.id)}
              >
                <span className="q-direction-name">{dossier.name}</span>
                <span className="q-cap">
                  {dossier.position ||
                    `${dossier.educationCount} 段教育 · ${dossier.experienceCount} 段工作`}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="q-direction-chip q-direction-add"
              onClick={() => {
                setCreatingDirection(true);
                setDirectionName("");
              }}
            >
              <Plus size={14} />
              新建方向
            </button>
          </div>

          {creatingDirection && (
            <form
              className="q-direction-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createDirection();
              }}
            >
              <input
                className="q-input"
                autoFocus
                value={directionName}
                maxLength={24}
                placeholder="例如：后端开发 / 产品经理 / 数据分析"
                onChange={(event) => setDirectionName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setCreatingDirection(false);
                }}
              />
              <button type="submit" className="q-btn q-btn-primary" disabled={!directionName.trim()}>
                创建
              </button>
              <button type="button" className="q-btn q-btn-ghost" onClick={() => setCreatingDirection(false)}>
                取消
              </button>
              <span className="q-cap">新档案从空白开始；创建后上传该方向自己的简历，不会复制其他方向的简历。</span>
            </form>
          )}

          {renamingDirection && (
            <form
              className="q-direction-form"
              onSubmit={(event) => {
                event.preventDefault();
                void renameDirection();
              }}
            >
              <input
                className="q-input"
                autoFocus
                value={renameDraft}
                maxLength={24}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setRenamingDirection(false);
                }}
              />
              <button type="submit" className="q-btn q-btn-primary" disabled={!renameDraft.trim()}>
                保存名称
              </button>
              <button type="button" className="q-btn q-btn-ghost" onClick={() => setRenamingDirection(false)}>
                取消
              </button>
            </form>
          )}

          <div className="q-toolbar" style={{ marginTop: "var(--s-4)" }}>
            <button
              type="button"
              className="q-btn q-btn-ghost q-btn-sm"
              onClick={() => {
                setRenameDraft(activeDossier?.name ?? "");
                setRenamingDirection(true);
                setCreatingDirection(false);
              }}
            >
              重命名当前方向
            </button>
            <button
              type="button"
              className="q-btn q-btn-danger q-btn-sm"
              disabled={state.profiles.length <= 1}
              title={state.profiles.length <= 1 ? "至少保留一个方向档案" : undefined}
              onClick={() => setDeleteDirectionConfirm(true)}
            >
              <Trash size={14} />
              删除当前方向
            </button>
          </div>

          {deleteDirectionConfirm && activeDossier && (
            <div className="q-insight" data-kind="warning" style={{ marginTop: "var(--s-4)" }}>
              <Warning size={16} />
              <div className="q-grow">
                <div className="q-insight-title">删除方向「{activeDossier.name}」？</div>
                <div className="q-insight-detail">
                  这个方向里的资料会一起删除，其他方向不受影响。删除后无法恢复。
                </div>
                <div className="q-toolbar" style={{ marginTop: "var(--s-3)" }}>
                  <button type="button" className="q-btn q-btn-ghost q-btn-sm" onClick={() => setDeleteDirectionConfirm(false)}>
                    保留
                  </button>
                  <button
                    type="button"
                    className="q-btn q-btn-primary q-btn-sm"
                    style={{ background: "var(--red)" }}
                    onClick={() => void deleteDirection()}
                  >
                    确认删除
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {importing && (
        <div className="q-insight" style={{ marginBottom: "var(--s-6)" }}>
          <Document size={16} />
          <div>
            <div className="q-insight-title">正在读取…</div>
            <div className="q-insight-detail">大文件可能需要几秒钟。</div>
          </div>
        </div>
      )}

      {importError && (
        <div className="q-insight" data-kind="warning" style={{ marginBottom: "var(--s-6)" }}>
          <Warning size={16} />
          <div>
            <div className="q-insight-title">重新上传失败</div>
            <div className="q-insight-detail">{importError}</div>
          </div>
        </div>
      )}

      {visibleWarnings.length > 0 && (
        <div className="q-insight" data-kind="warning" style={{ marginBottom: "var(--s-6)" }}>
          <Warning size={16} />
          <div>
            <div className="q-insight-title">有几点需要你确认</div>
            <ul style={{ marginTop: "var(--s-2)", display: "flex", flexDirection: "column", gap: "0.1875rem" }}>
              {visibleWarnings.map((warning, index) => (
                <li key={index} className="q-insight-detail">
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {profile.rawText &&
        profile.rawText.length > 500 &&
        profile.education.length === 0 &&
        profile.experience.length === 0 &&
        profile.projects.length === 0 && (
          <div className="q-insight" data-kind="warning" style={{ marginBottom: "var(--s-6)" }}>
            <Warning size={16} />
            <div>
              <div className="q-insight-title">文字已经提取，但没有识别出经历结构</div>
              <div className="q-insight-detail">
                常见原因是简历用了多栏或表格排版，或者标题不是常见写法。可以展开下方「提取出的原文」核对文字是否完整；
                也可以直接手动补充，或换一份排版更简单的 PDF 重新上传。
              </div>
            </div>
          </div>
        )}

      {summary.length > 0 && (
        <section className="q-block q-reveal" style={{ "--i": 1 } as React.CSSProperties}>
          <div className="q-group">
            {summary.map((line, index) => (
              <div className="q-group-row" key={index}>
                <CheckCircle size={15} style={{ color: "var(--green)", flex: "none" }} />
                <span className="q-grow">{line}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------- identity */}
      <section className="q-block">
        <SectionHead title="基本信息" sub="网申表单里出现频率最高的字段。">
          <AddButton label="添加字段" onClick={() => void updateProfile((draft) => {
            draft.identity.nationality ??= "中国";
          })} />
        </SectionHead>
        <div className="q-grid q-grid-2">
          <EditableField
            label="姓名"
            value={profile.identity.fullName}
            onChange={(value) => void updateProfile((draft) => { draft.identity.fullName = value || undefined; })}
          />
          <EditableField
            label="性别"
            value={profile.identity.gender}
            onChange={(value) => void updateProfile((draft) => { draft.identity.gender = value || undefined; })}
          />
          <EditableField
            label="出生日期"
            value={profile.identity.birthDate}
            placeholder="1999-03 或 1999-03-15"
            onChange={(value) => void updateProfile((draft) => { draft.identity.birthDate = value || undefined; })}
          />
          <EditableField
            label="民族"
            value={profile.identity.ethnicity}
            onChange={(value) => void updateProfile((draft) => { draft.identity.ethnicity = value || undefined; })}
          />
          <EditableField
            label="政治面貌"
            value={profile.identity.politicalStatus}
            onChange={(value) => void updateProfile((draft) => { draft.identity.politicalStatus = value || undefined; })}
          />
          <EditableField
            label="籍贯"
            value={profile.identity.nativePlace}
            onChange={(value) => void updateProfile((draft) => { draft.identity.nativePlace = value || undefined; })}
          />
          <EditableField
            label="身份证号"
            value={profile.identity.idNumber}
            sensitive
            onChange={(value) => void updateProfile((draft) => { draft.identity.idNumber = value || undefined; })}
          />
          <EditableField
            label="国籍"
            value={profile.identity.nationality}
            onChange={(value) => void updateProfile((draft) => { draft.identity.nationality = value || undefined; })}
          />
        </div>
      </section>

      {/* -------------------------------------------------------- contact */}
      <section className="q-block">
        <SectionHead title="联系方式" sub="扩展识别到邮箱或手机号字段时会优先使用这里。" />
        <div className="q-grid q-grid-2">
          <EditableField
            label="手机号码"
            value={profile.contact.phone}
            sensitive
            onChange={(value) => void updateProfile((draft) => { draft.contact.phone = value || undefined; })}
          />
          <EditableField
            label="电子邮箱"
            value={profile.contact.email}
            sensitive
            onChange={(value) => void updateProfile((draft) => { draft.contact.email = value || undefined; })}
          />
          <EditableField
            label="现居住地"
            value={profile.contact.currentCity}
            onChange={(value) => void updateProfile((draft) => { draft.contact.currentCity = value || undefined; })}
          />
          <EditableField
            label="通讯地址"
            value={profile.contact.address}
            sensitive
            onChange={(value) => void updateProfile((draft) => { draft.contact.address = value || undefined; })}
          />
          <EditableField
            label="微信号"
            value={profile.contact.wechat}
            onChange={(value) => void updateProfile((draft) => { draft.contact.wechat = value || undefined; })}
          />
          <EditableField
            label="个人主页 / GitHub"
            value={profile.contact.homepage ?? profile.contact.github}
            onChange={(value) => void updateProfile((draft) => {
              if (/github|gitee/i.test(value)) draft.contact.github = value || undefined;
              else draft.contact.homepage = value || undefined;
            })}
          />
          <EditableField
            label="紧急联系人"
            value={profile.contact.emergencyContactName}
            onChange={(value) => void updateProfile((draft) => { draft.contact.emergencyContactName = value || undefined; })}
          />
          <EditableField
            label="紧急联系电话"
            value={profile.contact.emergencyContactPhone}
            sensitive
            onChange={(value) => void updateProfile((draft) => { draft.contact.emergencyContactPhone = value || undefined; })}
          />
        </div>
      </section>

      {/* ------------------------------------------------------ education */}
      <section className="q-block">
        <SectionHead title="教育经历" sub={`共 ${profile.education.length} 段。表单有多行时按顺序对应。`}>
          <AddButton
            label="添加一段"
            onClick={() =>
              void updateProfile((draft) => {
                draft.education.push({ id: `edu-${Date.now().toString(36)}` });
              })
            }
          />
        </SectionHead>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          {profile.education.map((education, index) => (
            <EducationCard
              key={education.id}
              index={index}
              education={education}
              onEdit={(mutate) => void updateProfile((draft) => mutate(draft.education[index] as Education))}
              onRemove={() =>
                void updateProfile((draft) => {
                  draft.education.splice(index, 1);
                })
              }
            />
          ))}
          {profile.education.length === 0 && (
            <EmptyRow text="没有识别到教育经历。可以手动添加一段，或者重新上传更清晰的简历。" />
          )}
        </div>
      </section>

      {/* ----------------------------------------------------- experience */}
      <section className="q-block">
        <SectionHead title="工作与实习经历" sub={`共 ${profile.experience.length} 段。`}>
          <AddButton
            label="添加一段"
            onClick={() =>
              void updateProfile((draft) => {
                draft.experience.push({ id: `exp-${Date.now().toString(36)}`, highlights: [] });
              })
            }
          />
        </SectionHead>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          {profile.experience.map((experience, index) => (
            <ExperienceCard
              key={experience.id}
              experience={experience}
              onEdit={(mutate) => void updateProfile((draft) => mutate(draft.experience[index] as Experience))}
              onRemove={() =>
                void updateProfile((draft) => {
                  draft.experience.splice(index, 1);
                })
              }
            />
          ))}
          {profile.experience.length === 0 && (
            <EmptyRow text="没有识别到工作经历。应届生可以跳过，只保留项目经历。" />
          )}
        </div>
      </section>

      {/* -------------------------------------------------------- projects */}
      <section className="q-block">
        <SectionHead title="项目经历" sub={`共 ${profile.projects.length} 个项目。类型会对应网申里的“项目类别”。`}>
          <AddButton
            label="添加一个"
            onClick={() =>
              void updateProfile((draft) => {
                draft.projects.push({ id: `proj-${Date.now().toString(36)}`, highlights: [] });
              })
            }
          />
        </SectionHead>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          {profile.projects.map((project, index) => (
            <ProjectCard
              key={project.id}
              project={project}
              onEdit={(mutate) => void updateProfile((draft) => mutate(draft.projects[index] as Project))}
              onRemove={() =>
                void updateProfile((draft) => {
                  draft.projects.splice(index, 1);
                })
              }
            />
          ))}
          {profile.projects.length === 0 && (
            <EmptyRow text="没有识别到项目经历。科研、开源或个人作品都可以手动添加。" />
          )}
        </div>
      </section>

      {/* -------------------------------------------------------- skills */}
      <section className="q-block">
        <SectionHead title="技能、证书与荣誉" sub="网申中的“专业技能”“获奖情况”会从这里取值。" />
        <div className="q-card-lg">
          <ChipEditor
            label="专业技能"
            values={profile.skills.items}
            placeholder="输入后回车添加，例如 TypeScript"
            onChange={(values) => void updateProfile((draft) => { draft.skills.items = values; })}
          />
          <div style={{ height: "var(--s-5)" }} />
          <ChipEditor
            label="证书"
            values={profile.skills.certificates}
            placeholder="例如 CET-6 (585)"
            onChange={(values) => void updateProfile((draft) => { draft.skills.certificates = values; })}
          />
          <div style={{ height: "var(--s-5)" }} />
          <ChipEditor
            label="奖项荣誉"
            values={profile.skills.awards}
            placeholder="例如 2021年 校级一等奖学金"
            onChange={(values) => void updateProfile((draft) => { draft.skills.awards = values; })}
          />
          <div style={{ height: "var(--s-5)" }} />
          <ChipEditor
            label="兴趣爱好"
            values={profile.skills.interests}
            placeholder="例如 长跑"
            onChange={(values) => void updateProfile((draft) => { draft.skills.interests = values; })}
          />
        </div>
      </section>

      {/* ---------------------------------------------------- preference */}
      <section className="q-block">
        <SectionHead
          title="求职意向"
          sub="填写网申时，“意向城市”“期望薪资”等字段会用到。页面没有明确招聘类型时，会按“投递类型”筛选经历。"
        />
        <div className="q-grid q-grid-2">
          <label className="q-field-group">
            <span className="q-label">投递类型</span>
            <select
              className="q-select"
              value={profile.preference.targetTrack ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                void updateProfile((draft) => {
                  draft.preference.targetTrack =
                    value === "internship" || value === "campus" || value === "experienced"
                      ? value
                      : undefined;
                });
              }}
            >
              <option value="">未设置</option>
              <option value="internship">实习</option>
              <option value="campus">校招</option>
              <option value="experienced">社招</option>
            </select>
          </label>
          <EditableField
            label="意向岗位"
            value={profile.preference.position}
            onChange={(value) => void updateProfile((draft) => { draft.preference.position = value || undefined; })}
          />
          <EditableField
            label="意向城市"
            value={profile.preference.cities.join("、")}
            placeholder="多个城市用、分隔"
            onChange={(value) =>
              void updateProfile((draft) => {
                draft.preference.cities = value.split(/[、,，\s]+/).filter(Boolean);
              })
            }
          />
          <EditableField
            label="地点灵活度"
            value={profile.preference.relocation}
            placeholder="例如 多个城市均可、可调剂"
            onChange={(value) => void updateProfile((draft) => { draft.preference.relocation = value || undefined; })}
          />
          <EditableField
            label="期望薪资"
            value={profile.preference.salary}
            onChange={(value) => void updateProfile((draft) => { draft.preference.salary = value || undefined; })}
          />
          <EditableField
            label="到岗时间"
            value={profile.preference.availableFrom}
            placeholder="例如 2026年7月"
            onChange={(value) => void updateProfile((draft) => { draft.preference.availableFrom = value || undefined; })}
          />
        </div>
        <p className="q-cap" style={{ marginTop: "var(--s-3)" }}>
          投递类型只影响网申填写时的经历匹配：页面自己写明实习/校招/社招时以页面为准；页面没写明时用这里的设置。
        </p>
      </section>

      {/* ------------------------------------------------------ raw text */}
      {profile.rawText && (
        <section className="q-block">
          <SectionHead
            title="提取出的原文"
            sub="上面没有识别到的内容，可以先在这里核对是文件本身没读全，还是解析时漏掉了。"
          />
          <details className="q-card-lg q-raw-text">
            <summary>
              展开原文（{profile.rawText.length.toLocaleString()} 字）
            </summary>
            <pre>
              {profile.rawText.slice(0, 40_000)}
              {profile.rawText.length > 40_000 ? "\n…（仅显示前 40,000 字）" : ""}
            </pre>
          </details>
        </section>
      )}

      {/* ------------------------------------------------------ documents */}
      {state.documents.length > 0 && (
        <section className="q-block">
          <SectionHead title="已上传的文件" sub="只保存提取出的文字，原文件不会留存。" />
          <div className="q-group">
            {state.documents.map((document) => (
              <div className="q-group-row" key={document.id}>
                <Document size={15} style={{ flex: "none", color: "var(--ink-tertiary)" }} />
                <div className="q-grow">
                  <div className="q-strong q-truncate">{document.fileName}</div>
                  <div className="q-cap">
                    {document.kind === "resume" ? "简历" : document.kind === "jd" ? "岗位描述" : "其他"} ·{" "}
                    {relativeTime(document.uploadedAt)} · {document.text.length.toLocaleString()} 字
                  </div>
                </div>
                <button
                  type="button"
                  className="q-btn q-btn-ghost q-btn-sm"
                  onClick={() => {
                    void getStore()
                      .deleteDocument(document.id)
                      .then(() => reload())
                      .then(() => onToast("已删除该文件", "success"));
                  }}
                >
                  <Trash size={14} />
                  删除
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {profile.preference.position && state.analyses.length === 0 && (
        <div className="q-insight" style={{ marginTop: "var(--s-6)" }}>
          <InfoIcon />
          <div>
            <div className="q-insight-title">下一步：粘贴一个目标岗位</div>
            <div className="q-insight-detail">
              有了具体岗位，Quill 才能告诉你哪段经历最值得放在前面。{" "}
              <button
                type="button"
                className="q-btn q-btn-ghost q-btn-sm"
                style={{ padding: 0, height: "auto" }}
                onClick={() => onNavigate("tailor")}
              >
                去分析岗位 →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- components */

/**
 * Diff values can be a whole essay. Show enough to recognise the field, and
 * mask the ones the library treats as sensitive even though this is the
 * person's own screen — screens get shared.
 */
function previewValue(change: ProfileChange, key: "previous" | "next"): string {
  const raw = change[key] ?? "";
  const shown = change.sensitive ? maskValue(raw) : raw;
  return shown.length > 120 ? `${shown.slice(0, 120)}…` : shown;
}

function ModelConsent({
  file,
  destination,
  onCancel,
  onLocal,
  onModel,
}: {
  file: File;
  destination: string;
  onCancel: () => void;
  onLocal: () => void;
  onModel: () => void;
}): JSX.Element {
  return (
    <section
      className="q-card-lg q-reparse-review"
      role="alertdialog"
      aria-labelledby="model-consent-title"
      style={{ marginTop: "var(--s-4)" }}
    >
      <div>
        <h2 className="q-block-title" id="model-consent-title">
          识别前，请确认这份简历会上传
        </h2>
        <p className="q-block-sub">
          「{file.name}」的文字会发送到{destination || "模型服务"}
          ，由模型转写并整理成结构化资料。Quill 不会保存文件内容；对方服务是否会记录，取决于它的隐私政策。
          这也意味着简历内容在这段时间离开了这台设备。
        </p>
        <p className="q-block-sub" style={{ marginTop: "var(--s-2)" }}>
          也可以只用本机规则解析：不联网，但扫描件和图片读不出，字段准确度也会低一些。
        </p>
      </div>
      <div className="q-toolbar" style={{ marginTop: "var(--s-4)" }}>
        <button type="button" className="q-btn q-btn-ghost" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="q-btn q-btn-outline" onClick={onLocal}>
          仅本地解析
        </button>
        <button type="button" className="q-btn q-btn-primary" onClick={onModel}>
          上传并识别
        </button>
      </div>
    </section>
  );
}

function serverHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function Dropzone({
  active,
  busy,
  images,
  onSelect,
  onDrop,
  onDragOver,
  onDragLeave,
}: {
  active: boolean;
  busy: boolean;
  images: boolean;
  onSelect: () => void;
  onDrop: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="q-dropzone q-reveal"
      data-active={active}
      onClick={onSelect}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      disabled={busy}
      style={{ "--i": 1 } as React.CSSProperties}
    >
      <span className="q-dropzone-icon">
        <Upload size={22} />
      </span>
      <span className="q-dropzone-title">{busy ? "正在识别…" : "把简历拖到这里"}</span>
      <span className="q-dropzone-hint">
        支持 PDF、DOCX、TXT、Markdown{images ? "，以及 PNG / JPG 图片" : ""}，单个文件不超过 20 MB。
        <br />
        也可以点击这个区域选择文件。
      </span>
      <span className="q-btn q-btn-primary" style={{ marginTop: "var(--s-2)" }}>
        <Upload size={15} />
        选择文件
      </span>
    </button>
  );
}

function SectionHead({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="q-block-head">
      <div>
        <h2 className="q-block-title">{title}</h2>
        <p className="q-block-sub">{sub}</p>
      </div>
      {children}
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="q-btn q-btn-outline" onClick={onClick}>
      <Plus size={14} />
      {label}
    </button>
  );
}

/**
 * An editable value. Reads as text until focused, then becomes an input — so the
 * page stays scannable while remaining immediately correctable.
 */
function EditableField({
  label,
  value,
  placeholder,
  sensitive,
  onChange,
}: {
  label: string;
  value?: string;
  placeholder?: string;
  sensitive?: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value ?? "");
  const [focused, setFocused] = useState(false);
  const dirty = draft !== (value ?? "");

  return (
    <label className="q-field-group">
      <span className="q-label">
        {label}
        {sensitive && <span className="q-cap" style={{ marginLeft: "auto" }}>敏感</span>}
      </span>
      <input
        className="q-input"
        value={focused ? draft : (value ?? "")}
        placeholder={placeholder ?? "未填写"}
        type={sensitive ? "text" : "text"}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => {
          setDraft(value ?? "");
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          if (dirty) onChange(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function EducationCard({
  index,
  education,
  onEdit,
  onRemove,
}: {
  index: number;
  education: Education;
  onEdit: (mutate: (draft: Education) => void) => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className="q-card-lg">
      <div className="q-between" style={{ marginBottom: "var(--s-4)" }}>
        <span className="q-chip q-chip-neutral">第 {index + 1} 段</span>
        <button type="button" className="q-btn q-btn-danger q-btn-sm" onClick={onRemove}>
          <Trash size={14} />
          删除
        </button>
      </div>
      <div className="q-grid q-grid-2">
        <EditableField label="学校" value={education.school} onChange={(value) => onEdit((draft) => { draft.school = value || undefined; })} />
        <EditableField label="专业" value={education.major} onChange={(value) => onEdit((draft) => { draft.major = value || undefined; })} />
        <EditableField label="学历" value={education.degree} onChange={(value) => onEdit((draft) => { draft.degree = value || undefined; })} />
        <EditableField label="学位" value={education.academicDegree} onChange={(value) => onEdit((draft) => { draft.academicDegree = value || undefined; })} />
        <EditableField
          label="入学时间"
          value={education.dates?.start}
          placeholder="2018-09"
          onChange={(value) => onEdit((draft) => { draft.dates = { ...draft.dates, start: value || undefined }; })}
        />
        <EditableField
          label="毕业时间"
          value={education.dates?.current ? "至今" : education.dates?.end}
          placeholder="2022-06"
          onChange={(value) =>
            onEdit((draft) => {
              if (value === "至今") draft.dates = { ...draft.dates, current: true, end: undefined };
              else draft.dates = { ...draft.dates, current: false, end: value || undefined };
            })
          }
        />
        <EditableField label="GPA" value={education.gpa} onChange={(value) => onEdit((draft) => { draft.gpa = value || undefined; })} />
        <EditableField label="专业排名" value={education.rank} onChange={(value) => onEdit((draft) => { draft.rank = value || undefined; })} />
      </div>
      {education.dates && (
        <p className="q-cap" style={{ marginTop: "var(--s-3)" }}>
          表单里会显示为：{formatRange(education.dates)}
        </p>
      )}
    </div>
  );
}

function ExperienceCard({
  experience,
  onEdit,
  onRemove,
}: {
  experience: Experience;
  onEdit: (mutate: (draft: Experience) => void) => void;
  onRemove: () => void;
}): JSX.Element {
  const experienceKind = experienceKindOf(experience);

  return (
    <div className="q-card-lg">
      <div className="q-between" style={{ marginBottom: "var(--s-4)" }}>
        <span className="q-chip q-chip-neutral">
          {[experience.company, experience.title].filter(Boolean).join(" · ") || "新的一段经历"}
        </span>
        <button type="button" className="q-btn q-btn-danger q-btn-sm" onClick={onRemove}>
          <Trash size={14} />
          删除
        </button>
      </div>

      <div className="q-grid q-grid-2">
        <EditableField label="公司 / 单位" value={experience.company} onChange={(value) => onEdit((draft) => { draft.company = value || undefined; })} />
        <EditableField label="职位" value={experience.title} onChange={(value) => onEdit((draft) => { draft.title = value || undefined; })} />
        <EditableField label="部门" value={experience.department} onChange={(value) => onEdit((draft) => { draft.department = value || undefined; })} />
        <label className="q-field-group">
          <span className="q-label">经历性质</span>
          <select
            className="q-select"
            value={experienceKind ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              onEdit((draft) => {
                if (!value) {
                  draft.employmentType = undefined;
                } else if (value === "internship") {
                  draft.employmentType = experienceKind === "internship" ? draft.employmentType : "实习";
                } else {
                  draft.employmentType = experienceKind === "employment" ? draft.employmentType : "全职";
                }
              });
            }}
          >
            <option value="">未注明</option>
            <option value="internship">实习</option>
            <option value="employment">工作</option>
          </select>
        </label>
        <EditableField label="工作地点" value={experience.city} onChange={(value) => onEdit((draft) => { draft.city = value || undefined; })} />
        <EditableField
          label="开始时间"
          value={experience.dates?.start}
          placeholder="2020-07"
          onChange={(value) => onEdit((draft) => { draft.dates = { ...draft.dates, start: value || undefined }; })}
        />
        <EditableField
          label="结束时间"
          value={experience.dates?.current ? "至今" : experience.dates?.end}
          placeholder="2023-06 或 至今"
          onChange={(value) =>
            onEdit((draft) => {
              if (value === "至今") draft.dates = { ...draft.dates, current: true, end: undefined };
              else draft.dates = { ...draft.dates, current: false, end: value || undefined };
            })
          }
        />
      </div>
      <p className="q-cap" style={{ marginTop: "var(--s-2)" }}>
        经历性质会先按简历区块标题和职位名称自动识别；混合标题或识别不出时，再在这里手动选择。
      </p>

      <div style={{ marginTop: "var(--s-5)" }}>
        <MultilineField
          label="工作内容"
          value={experience.highlights.join("\n")}
          placeholder="每行一条工作内容，尽量写清做了什么、带来了什么结果"
          onChange={(value) =>
            onEdit((draft) => {
              draft.highlights = splitLines(value);
            })
          }
        />
        <p className="q-cap" style={{ marginTop: "var(--s-2)" }}>
          一行一条即可。网申里需要长段落时，Quill 会把它们合成一段。
        </p>
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  onEdit,
  onRemove,
}: {
  project: Project;
  onEdit: (mutate: (draft: Project) => void) => void;
  onRemove: () => void;
}): JSX.Element {
  const content =
    project.highlights.length > 0 ? project.highlights.join("\n") : (project.summary ?? "");

  return (
    <div className="q-card-lg">
      <div className="q-between" style={{ marginBottom: "var(--s-4)" }}>
        <span className="q-chip q-chip-neutral">
          {[project.category ? PROJECT_CATEGORY_LABELS[project.category] : "", project.name]
            .filter(Boolean)
            .join(" · ") || "新的项目"}
        </span>
        <button type="button" className="q-btn q-btn-danger q-btn-sm" onClick={onRemove}>
          <Trash size={14} />
          删除
        </button>
      </div>

      <div className="q-grid q-grid-2">
        <EditableField
          label="项目名称"
          value={project.name}
          onChange={(value) => onEdit((draft) => { draft.name = value || undefined; })}
        />
        <label className="q-field-group">
          <span className="q-label">项目类型</span>
          <select
            className="q-select"
            value={project.category ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              onEdit((draft) => {
                draft.category = value ? (value as ProjectCategory) : undefined;
              });
            }}
          >
            <option value="">未分类</option>
            {PROJECT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {PROJECT_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </label>
        <EditableField
          label="担任角色"
          value={project.role}
          onChange={(value) => onEdit((draft) => { draft.role = value || undefined; })}
        />
        <EditableField
          label="项目链接"
          value={project.link}
          placeholder="GitHub、作品页或论文地址"
          onChange={(value) => onEdit((draft) => { draft.link = value || undefined; })}
        />
        <EditableField
          label="开始时间"
          value={project.dates?.start}
          placeholder="2023-03"
          onChange={(value) => onEdit((draft) => { draft.dates = { ...draft.dates, start: value || undefined }; })}
        />
        <EditableField
          label="结束时间"
          value={project.dates?.current ? "至今" : project.dates?.end}
          placeholder="2024-06 或 至今"
          onChange={(value) =>
            onEdit((draft) => {
              if (value === "至今") draft.dates = { ...draft.dates, current: true, end: undefined };
              else draft.dates = { ...draft.dates, current: false, end: value || undefined };
            })
          }
        />
      </div>

      <div style={{ marginTop: "var(--s-5)" }}>
        <MultilineField
          label="项目内容"
          value={content}
          placeholder="每行一条：项目做了什么、你负责什么、结果如何"
          onChange={(value) =>
            onEdit((draft) => {
              draft.highlights = splitLines(value);
              draft.summary = undefined;
            })
          }
        />
        <p className="q-cap" style={{ marginTop: "var(--s-2)" }}>
          科研项目、开源项目、个人作品都可以放在这里；类型会用于网申里的“项目类别”。
        </p>
      </div>
    </div>
  );
}

/**
 * A textarea that keeps its own draft while focused.
 *
 * Saving on every keystroke would re-render the controlled value from global
 * state, which commits an in-progress Chinese IME composition and loses the
 * pinyin. Local state keeps typing synchronous; the edit is persisted on blur.
 */
function MultilineField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  return (
    <label className="q-field-group">
      <span className="q-label">{label}</span>
      <textarea
        className="q-textarea"
        value={focused ? draft : value}
        placeholder={placeholder}
        style={{ minHeight: "7rem" }}
        onFocus={() => {
          setDraft(value);
          setFocused(true);
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setFocused(false);
          if (draft !== value) onChange(draft);
        }}
      />
    </label>
  );
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function ChipEditor({
  label,
  values,
  placeholder,
  onChange,
}: {
  label: string;
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");

  const add = (): void => {
    const value = draft.trim();
    if (!value || values.includes(value)) return;
    onChange([...values, value]);
    setDraft("");
  };

  return (
    <div className="q-field-group">
      <span className="q-label">{label}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)", minHeight: "1.75rem" }}>
        {values.length === 0 && <span className="q-cap">暂无内容</span>}
        {values.map((value, index) => (
          <span className="q-chip q-chip-neutral" key={`${value}-${index}`} style={{ paddingRight: "0.25rem" }}>
            {value}
            <button
              type="button"
              className="q-icon-btn"
              style={{ width: "1rem", height: "1rem" }}
              aria-label={`移除 ${value}`}
              onClick={() => onChange(values.filter((_, at) => at !== index))}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
        <input
          className="q-input"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="q-btn q-btn-outline" onClick={add} disabled={!draft.trim()}>
          <Plus size={14} />
          添加
        </button>
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="q-card-lg" style={{ display: "flex", gap: "var(--s-3)", alignItems: "flex-start" }}>
      <Info size={16} style={{ color: "var(--ink-tertiary)", flex: "none", marginTop: "0.125rem" }} />
      <span className="q-sub">{text}</span>
    </div>
  );
}

function InfoIcon(): JSX.Element {
  return <Info size={15} style={{ color: "var(--ink-tertiary)", flex: "none", marginTop: "0.125rem" }} />;
}
