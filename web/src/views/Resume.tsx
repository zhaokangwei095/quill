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
  formatRange,
  summarizeProfile,
  type Education,
  type Experience,
  type Profile,
} from "@quill/core";
import { useWorkbench } from "../state.js";
import { getStore } from "../data/store.js";
import { ACCEPTED_TYPES, extractText, validateFile } from "../data/extract.js";
import { relativeTime } from "../data/format.js";
import {
  Book,
  CheckCircle,
  Document,
  Info,
  Plus,
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
  const { state, reload, patch } = useWorkbench();
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | undefined>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const profile = state.profile;

  /* ------------------------------------------------------------- import */

  const importFile = useCallback(
    async (file: File) => {
      const invalid = validateFile(file);
      if (invalid) {
        setImportError(invalid);
        return;
      }
      setImporting(true);
      setImportError(undefined);
      try {
        const extracted = await extractText(file);
        if (!extracted.text.trim()) {
          throw new Error("这份文件里没有可读取的文字，可能是扫描件。");
        }

        await getStore().importDocument({
          kind: "resume",
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          text: extracted.text,
        });
        await reload();
        setWarnings(extracted.warnings);
        onToast(`已读取 ${file.name}`, "success");
      } catch (error) {
        setImportError(error instanceof Error ? error.message : "读取文件失败");
      } finally {
        setImporting(false);
      }
    },
    [onToast, reload],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      const file = event.dataTransfer.files[0];
      if (file) void importFile(file);
    },
    [importFile],
  );

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

  const summary = useMemo(() => (profile ? summarizeProfile(profile) : []), [profile]);

  /* --------------------------------------------------------------- render */

  if (!profile) {
    return (
      <div className="q-page">
        <header className="q-page-head q-reveal">
          <h1 className="q-page-title">上传一份简历，建立你的资料库。</h1>
          <p className="q-page-lead">
            Quill 会读取其中的姓名、联系方式、教育与工作经历，形成结构化资料。之后在网申页面，
            扩展就靠这些内容识别和填写字段。
          </p>
        </header>

        <Dropzone
          active={dragActive}
          busy={importing}
          onSelect={() => inputRef.current?.click()}
          onDrop={onDrop}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
        />

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_TYPES}
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

        <div className="q-consent" style={{ marginTop: "var(--s-8)" }}>
          <InfoIcon />
          <div>
            简历文件本身不会离开这台设备：Quill 只在本机提取其中的文字，并把文字保存在浏览器存储里，
            不上传到任何服务器。你可以随时在设置里删除。
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
              这些是从简历中读到的内容。有读错的地方直接改，改完扩展里立刻生效。
            </p>
          </div>
          <div className="q-toolbar">
            <button type="button" className="q-btn q-btn-outline" onClick={() => inputRef.current?.click()}>
              <Upload size={15} />
              重新上传
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED_TYPES}
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

      {warnings.length > 0 && (
        <div className="q-insight" data-kind="warning" style={{ marginBottom: "var(--s-6)" }}>
          <Warning size={16} />
          <div>
            <div className="q-insight-title">有几点需要你确认</div>
            <ul style={{ marginTop: "var(--s-2)", display: "flex", flexDirection: "column", gap: "0.1875rem" }}>
              {warnings.map((warning, index) => (
                <li key={index} className="q-insight-detail">
                  {warning}
                </li>
              ))}
            </ul>
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
        <SectionHead title="求职意向" sub="填写网申时，“意向城市”“期望薪资”等字段会用到。" />
        <div className="q-grid q-grid-2">
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
      </section>

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

function Dropzone({
  active,
  busy,
  onSelect,
  onDrop,
  onDragOver,
  onDragLeave,
}: {
  active: boolean;
  busy: boolean;
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
      <span className="q-dropzone-title">{busy ? "正在读取…" : "把简历拖到这里"}</span>
      <span className="q-dropzone-hint">
        支持 PDF、DOCX、TXT 与 Markdown，单个文件不超过 12 MB。
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
  const [newHighlight, setNewHighlight] = useState("");

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

      <div style={{ marginTop: "var(--s-5)" }}>
        <span className="q-label" style={{ display: "block", marginBottom: "var(--s-3)" }}>
          工作内容
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
          {experience.highlights.map((highlight, index) => (
            <div key={index} style={{ display: "flex", gap: "var(--s-2)", alignItems: "flex-start" }}>
              <textarea
                className="q-textarea"
                value={highlight}
                style={{ minHeight: "3rem" }}
                onChange={(event) =>
                  onEdit((draft) => {
                    draft.highlights[index] = event.target.value;
                  })
                }
              />
              <button
                type="button"
                className="q-btn q-btn-ghost q-btn-sm"
                aria-label="删除这一条"
                onClick={() =>
                  onEdit((draft) => {
                    draft.highlights.splice(index, 1);
                  })
                }
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
          <input
            className="q-input"
            value={newHighlight}
            placeholder="添加一条工作内容，尽量带上数字"
            onChange={(event) => setNewHighlight(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && newHighlight.trim()) {
                onEdit((draft) => draft.highlights.push(newHighlight.trim()));
                setNewHighlight("");
              }
            }}
          />
          <button
            type="button"
            className="q-btn q-btn-outline"
            disabled={!newHighlight.trim()}
            onClick={() => {
              onEdit((draft) => draft.highlights.push(newHighlight.trim()));
              setNewHighlight("");
            }}
          >
            <Plus size={14} />
            添加
          </button>
        </div>
      </div>
    </div>
  );
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
