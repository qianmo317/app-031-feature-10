<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  useStore,
  createJob,
  deleteJob,
  duplicateJob,
  createSampleJob,
  commitImportJobs
} from '../lib/store'
import { parseArchive, type ImportPlan } from '../lib/archive'
import { runSelfTest, type SelfTestReport } from '../lib/selftest'
import { toast } from '../lib/ui'
import { pct, money } from '../lib/format'

const router = useRouter()
const { state } = useStore()
const newName = ref('')
const showSelfTest = ref(false)
const report = ref<SelfTestReport | null>(null)
const testing = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const jobs = computed(() => state.jobs)
const availableOffcuts = computed(() => state.offcuts.filter((o) => o.available).length)

function totalQty(jobId: string): number {
  const j = state.jobs.find((x) => x.id === jobId)
  return j ? j.parts.reduce((a, p) => a + p.qty, 0) : 0
}

function onCreate(): void {
  const job = createJob(newName.value)
  newName.value = ''
  router.push(`/parts/${job.id}`)
}
function onSample(): void {
  const job = createSampleJob()
  router.push(`/parts/${job.id}`)
}
function onDelete(id: string, name: string): void {
  if (window.confirm(`删除项目「${name}」？该操作不可恢复。`)) {
    deleteJob(id)
    toast('项目已删除', 'good')
  }
}
function onDuplicate(id: string): void {
  const j = duplicateJob(id)
  if (j) toast('已复制（排样结果需重新生成）', 'good')
}
async function runTest(): Promise<void> {
  testing.value = true
  report.value = null
  await new Promise((r) => setTimeout(r, 30))
  try {
    report.value = runSelfTest()
    toast(report.value.ok ? '算法自检全部通过' : '存在失败断言，请查看', report.value.ok ? 'good' : 'bad')
  } finally {
    testing.value = false
  }
}

// ---- 导入：先核对（差异清单 + 补全清单），确认后整批写入，可整批退回 ----
const importPlan = ref<ImportPlan | null>(null)
const importFileName = ref('')
const decisions = reactive<Record<string, 'skip' | 'overwrite' | undefined>>({})

function onImportClick(): void {
  fileInput.value?.click()
}
function onFile(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const plan = parseArchive(String(reader.result), state.jobs)
    if (plan.entries.length === 0) {
      toast(plan.errors[0] ?? '文件格式不正确', 'bad', 3600)
      return
    }
    Object.keys(decisions).forEach((k) => delete decisions[k])
    importFileName.value = file.name
    importPlan.value = plan
  }
  reader.readAsText(file)
  ;(e.target as HTMLInputElement).value = ''
}

const undecidedConflicts = computed(
  () => importPlan.value?.entries.filter((en) => en.status === 'conflict' && !decisions[en.job.id]) ?? []
)
const commitList = computed(
  () =>
    importPlan.value?.entries.filter(
      (en) => en.status === 'new' || (en.status === 'conflict' && decisions[en.job.id] === 'overwrite')
    ) ?? []
)
const totalNotes = computed(
  () => importPlan.value?.entries.reduce((a, en) => a + en.notes.length, 0) ?? 0
)
const totalRecomputed = computed(
  () => importPlan.value?.entries.reduce((a, en) => a + en.recomputed.length, 0) ?? 0
)

function confirmImport(): void {
  if (!importPlan.value || undecidedConflicts.value.length > 0) return
  const res = commitImportJobs(
    commitList.value.map((en) => ({
      job: en.job,
      mode: en.status === 'conflict' ? ('overwrite' as const) : ('add' as const)
    }))
  )
  if (res.ok) {
    toast(
      `已导入 ${res.count} 个项目；本次补默认/重算共 ${totalNotes.value} 项` +
        (totalRecomputed.value > 0 ? `（其中重算 ${totalRecomputed.value} 项，已在结果中标记，与历史单据可能不一致）` : ''),
      'good',
      4600
    )
    importPlan.value = null
  } else {
    toast(`导入失败，已回退到导入前：${res.error}`, 'bad', 4600)
  }
}
function cancelImport(): void {
  importPlan.value = null
  toast('已取消，未写入任何数据')
}
function fmtTime(ts: number): string {
  return ts > 0 ? new Date(ts).toLocaleString('zh-CN') : '未知'
}
</script>

<template>
  <div>
    <section class="hero panel no-print">
      <div>
        <h1>板材开料优化</h1>
        <p class="muted" style="margin: 6px 0 0">
          录入柜体零件 → guillotine 贯通排样（纹理/锯路/修边硬约束）→ 裁切步骤动画 → 下料单/标签。
          纯前端运行，断网可用，数据只存在本机。
        </p>
      </div>
      <div class="spacer" />
      <div class="hero-actions">
        <input
          v-model="newName"
          placeholder="新项目名称，如：万科3-1802"
          @keydown.enter="onCreate"
          style="width: 230px"
        />
        <button class="primary" @click="onCreate">＋ 新建项目</button>
        <button @click="onSample">载入示例 BOM</button>
        <button @click="onImportClick">导入 JSON</button>
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          style="display: none"
          @change="onFile"
        />
      </div>
    </section>

    <!-- 导入核对：差异清单 + 补全清单，确认才整批写入 -->
    <section v-if="importPlan" class="panel import-panel no-print">
      <h3 style="font-size: 15px">导入核对：{{ importFileName }}</h3>
      <p class="muted small" style="margin: 4px 0 10px">
        共 {{ importPlan.entries.length }} 个项目。确认后整批写入本机存档；取消则整批退回，不写任何数据。
        文件中的项目编号与创建时间保持原样。
      </p>
      <div v-if="importPlan.errors.length > 0" class="imp-errors">
        <p v-for="(er, i) in importPlan.errors" :key="i" class="small bad-text">⚠ {{ er }}</p>
      </div>

      <div v-for="en in importPlan.entries" :key="en.job.id" class="imp-item">
        <div class="row">
          <b>{{ en.job.name }}</b>
          <span v-if="en.status === 'new'" class="tag good">新增</span>
          <span v-else-if="en.status === 'same'" class="tag">与本机一致 · 跳过</span>
          <span v-else class="tag warn">编号冲突 · 需选择</span>
        </div>
        <p class="small muted" style="margin: 4px 0">
          编号 {{ en.job.id }} · 创建于 {{ fmtTime(en.job.createdAt) }} · 零件
          {{ en.job.parts.length }} 种 · 板材 {{ en.job.boards.length }} 种
          <span v-if="en.job.result"> · 已排样 {{ en.job.result.boardsUsed }} 张板</span>
          <span v-else> · 未排样</span>
        </p>

        <template v-if="en.notes.length > 0">
          <p class="small" style="margin: 6px 0 2px"><b>本次补全 {{ en.notes.length }} 项：</b></p>
          <ul class="imp-notes">
            <li v-for="(n, i) in en.notes" :key="i">
              <span class="tag" :class="n.action === '重算' ? 'warn' : ''">{{ n.action }}</span>
              <code>{{ n.path }}</code> — {{ n.detail }}
            </li>
          </ul>
          <p v-if="en.recomputed.length > 0" class="small bad-text" style="margin: 4px 0">
            ※ 含 {{ en.recomputed.length }} 项重算值（按当前明细由排样内核算出，已标记），与历史打印单据可能不一致。
          </p>
        </template>
        <p v-else class="small muted" style="margin: 4px 0">字段完整，无需补全。</p>

        <div v-if="en.status === 'conflict'" class="imp-diff">
          <p class="small" style="margin: 0 0 4px"><b>与本机已有项目编号相同，逐项差异：</b></p>
          <ul>
            <li v-for="(d, i) in en.diff" :key="i" class="small">{{ d }}</li>
          </ul>
          <div class="row" style="gap: 18px; margin-top: 6px">
            <label class="small">
              <input type="radio" value="skip" v-model="decisions[en.job.id]" />
              保留本机版本（跳过文件中的这个项目）
            </label>
            <label class="small">
              <input type="radio" value="overwrite" v-model="decisions[en.job.id]" />
              用文件版本覆盖本机（本机现有内容将被替换）
            </label>
          </div>
        </div>
        <p v-else-if="en.status === 'same'" class="small muted" style="margin: 4px 0">
          与本机内容完全一致，自动跳过（同一份文件重复导入不会写成两版）。
        </p>
      </div>

      <div class="row" style="margin-top: 12px">
        <button
          class="primary"
          :disabled="undecidedConflicts.length > 0 || commitList.length === 0"
          @click="confirmImport"
        >
          确认导入 {{ commitList.length }} 项（整批写入）
        </button>
        <button @click="cancelImport">取消（整批退回）</button>
        <span v-if="undecidedConflicts.length > 0" class="small bad-text">
          还有 {{ undecidedConflicts.length }} 个编号冲突未选择处理方式
        </span>
      </div>
    </section>

    <div class="row wrap" style="margin: 16px 0 10px">
      <h2 style="font-size: 16px">项目列表（{{ jobs.length }}）</h2>
      <div class="spacer" />
      <router-link to="/offcuts" class="tag good">可用余料 {{ availableOffcuts }} 块 →</router-link>
      <button class="sm" @click="showSelfTest = !showSelfTest">
        {{ showSelfTest ? '收起' : '运行' }}算法自检（100 组随机断言 + 存档迁移）
      </button>
    </div>

    <section v-if="showSelfTest" class="panel selftest no-print">
      <div class="row">
        <button class="primary sm" :disabled="testing" @click="runTest">
          {{ testing ? '自检中…' : '运行自检' }}
        </button>
        <span v-if="report" :class="['tag', report.ok ? 'good' : 'bad']">
          {{ report.ok ? `全部通过（${report.elapsedMs}ms）` : '存在失败项' }}
        </span>
        <span class="muted small">
          覆盖：100 组 guillotine 零反例、纹理零旋转、锯路/修边、守恒、封边复算、
          30 件 ≤20 刀且逐刀模拟还原、余料再利用、300 件 &lt;1.5s、微调合法性、存档迁移往返
        </span>
      </div>
      <table v-if="report" class="grid" style="margin-top: 10px">
        <tbody>
          <tr v-for="(c, i) in report.checks" :key="i">
            <td style="width: 34px; text-align: center">{{ c.ok ? '✅' : '❌' }}</td>
            <td>{{ c.name }}</td>
            <td class="muted small">{{ c.detail }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-if="jobs.length === 0" class="empty panel">
      <p>还没有项目。点击右上角「新建项目」或「载入示例 BOM」开始。</p>
    </div>

    <div class="job-grid">
      <article v-for="job in jobs" :key="job.id" class="panel job-card">
        <div class="row">
          <h3 style="font-size: 15px">{{ job.name }}</h3>
          <div class="spacer" />
          <span v-if="job.result" class="tag good">已排样</span>
          <span v-else class="tag">未排样</span>
        </div>
        <p class="muted small" style="margin: 6px 0">
          {{ new Date(job.createdAt).toLocaleString('zh-CN') }} ·
          {{ totalQty(job.id) }} 件零件 · {{ job.boards.length }} 种板材
        </p>
        <div v-if="job.result" class="job-stats">
          <div><b>{{ job.result.boardsUsed }}</b><span>用板（张）</span></div>
          <div>
            <b>{{ pct(job.result.sheets.reduce((a, s) => a + s.usedAreaMm2, 0) /
              job.result.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)) }}</b>
            <span>综合利用率</span>
          </div>
          <div>
            <b class="save">{{ job.result.savedBoards }}</b>
            <span>比随手排省（张）</span>
          </div>
        </div>
        <p v-if="job.result" class="small muted" style="margin: 6px 0 10px">
          约省 {{ money(job.result.savedCents) }} ｜ 封边
          {{ (job.result.edgeBandM.exposed + job.result.edgeBandM.normal).toFixed(1) }}m
        </p>
        <div v-else style="height: 34px"></div>
        <div class="row">
          <router-link :to="`/parts/${job.id}`" class="btn-link">零件清单</router-link>
          <router-link :to="`/nest/${job.id}`" class="btn-link">排样</router-link>
          <router-link :to="`/stats/${job.id}`" class="btn-link">统计</router-link>
          <div class="spacer" />
          <button class="sm" @click="onDuplicate(job.id)">复制</button>
          <button class="sm ghost-danger" @click="onDelete(job.id, job.name)">删除</button>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.hero h1 {
  font-size: 20px;
}
.hero-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.selftest {
  margin-bottom: 16px;
}
.import-panel {
  margin: 14px 0;
  border-color: var(--c-primary);
}
.imp-errors {
  background: var(--c-bad-bg);
  border-radius: 6px;
  padding: 6px 12px;
  margin-bottom: 8px;
}
.bad-text {
  color: var(--c-bad);
}
.imp-item {
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 10px;
}
.imp-notes {
  margin: 4px 0;
  padding-left: 4px;
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
}
.imp-notes li {
  font-size: 12px;
  padding: 2px 0;
  color: var(--c-ink-2);
}
.imp-notes code {
  font-size: 11px;
  background: #f4f7f3;
  border-radius: 4px;
  padding: 0 4px;
}
.imp-diff {
  background: #fffbeb;
  border: 1px solid #f0d9b5;
  border-radius: 8px;
  padding: 8px 12px;
  margin-top: 8px;
}
.imp-diff ul {
  margin: 0;
  padding-left: 18px;
}
.empty {
  text-align: center;
  color: var(--c-ink-2);
  padding: 40px;
}
.job-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
.job-card {
  display: flex;
  flex-direction: column;
}
.job-stats {
  display: flex;
  gap: 8px;
  margin: 8px 0;
}
.job-stats > div {
  flex: 1;
  background: #f4f7f3;
  border-radius: 6px;
  padding: 8px;
  text-align: center;
}
.job-stats b {
  display: block;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.job-stats .save {
  color: var(--c-primary);
}
.job-stats span {
  font-size: 11px;
  color: var(--c-ink-2);
}
.btn-link {
  font-size: 13px;
  padding: 4px 8px;
}
</style>
