<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  useStore,
  createJob,
  deleteJob,
  duplicateJob,
  createSampleJob,
  planJobImport,
  applyImportPlan
} from '../lib/store'
import type { ImportPlan } from '../lib/archive'
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
const importPlan = ref<ImportPlan | null>(null)

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
function onImportClick(): void {
  fileInput.value?.click()
}
function onFile(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const plan = planJobImport(String(reader.result))
    if (!plan.ok) {
      toast(plan.error ?? '文件格式不正确', 'bad')
      return
    }
    // 先核对：差异清单给人看过、确认后才整批写入；取消即整批退回
    importPlan.value = plan
  }
  reader.readAsText(file)
  ;(e.target as HTMLInputElement).value = ''
}
function cancelImport(): void {
  importPlan.value = null
  toast('已取消导入，本机存档未改动', 'info')
}
function confirmImport(decision: 'new' | 'overwrite' | 'copy' = 'new'): void {
  const plan = importPlan.value
  if (!plan) return
  const out = applyImportPlan(plan, decision)
  if (out.error) {
    toast(out.error, 'bad', 4200)
    return
  }
  importPlan.value = null
  if (out.noop) {
    toast('本机已有完全相同的项目，未重复写入', 'info')
    return
  }
  const job = out.job!
  toast(
    decision === 'overwrite'
      ? '已用文件覆盖本机项目'
      : decision === 'copy'
        ? '已作为副本导入（本机原项目保留）'
        : '项目 JSON 已导入',
    'good'
  )
  router.push(job.result ? `/nest/${job.id}` : `/parts/${job.id}`)
}
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
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

    <!-- 导入前核对：差异清单确认后才整批写入，可整批退回 -->
    <section v-if="importPlan && importPlan.job" class="panel import-panel no-print">
      <h3 style="font-size: 15px; margin-bottom: 8px">导入前核对 · {{ importPlan.job.name }}</h3>
      <p class="small muted" style="margin: 0 0 10px">
        编号 {{ importPlan.job.id }}（保持文件原样，不重新生成） · 创建于
        {{ fmtTime(importPlan.job.createdAt) }} · 零件 {{ importPlan.job.parts.length }} 种 · 板材
        {{ importPlan.job.boards.length }} 种 ·
        {{ importPlan.job.result ? '含排样结果' : '无排样结果' }}
      </p>

      <div v-if="importPlan.filled.length > 0" class="issue">
        <b>老版本存档，已按默认值补齐 {{ importPlan.filled.length }} 项：</b>
        <ul>
          <li v-for="(f, i) in importPlan.filled" :key="i">
            <code>{{ f.path }}</code> → {{ f.value }}<span class="muted">（{{ f.reason }}）</span>
          </li>
        </ul>
      </div>

      <div v-if="importPlan.recompute" class="issue warn">
        <b>
          排样结果缺 {{ importPlan.recompute.missing.length }} 项，已按当前明细用排样内核重算并标记：
        </b>
        <ul>
          <li v-for="(m, i) in importPlan.recompute.missing.slice(0, 12)" :key="i">
            <code>{{ m }}</code>
          </li>
          <li v-if="importPlan.recompute.missing.length > 12" class="muted">
            …共 {{ importPlan.recompute.missing.length }} 项
          </li>
        </ul>
        <p class="small" style="margin: 6px 0 0">
          ⚠️ 重算版与当时发到车间的那版可能不一致：据此打印的下料单/标签与件上的旧单据可能对不上。
          各页面与打印单据都会标明「导入重算版」，不冒充当时那一次。
        </p>
      </div>

      <div v-if="importPlan.preservedUnknown.length > 0" class="issue">
        <b>原样保留 {{ importPlan.preservedUnknown.length }} 个本版本不认识的字段（不丢失）：</b>
        <code v-for="k in importPlan.preservedUnknown" :key="k" class="unk">{{ k }}</code>
      </div>

      <div v-if="importPlan.missingOffcutRefs > 0" class="issue warn">
        ⚠️ 文件引用 {{ importPlan.missingOffcutRefs }} 块本机不存在的登记余料，重算/展示未将其计入，
        与导出那台机器上的结果可能有差异。
      </div>
      <div v-if="importPlan.staleOffcuts > 0" class="issue warn">
        ⚠️ 本机「余料登记」里有 {{ importPlan.staleOffcuts }} 条源于本项目旧结果——重算后板号可能对不上，
        这几条仍按旧值保留，请到余料页人工核对（这是唯一仍拿旧值的地方）。
      </div>

      <!-- 编号冲突：单独点出来让人定，不许悄悄覆盖 -->
      <div v-if="importPlan.conflict" class="issue bad">
        <template v-if="importPlan.conflict.identical">
          <b>本机已有完全相同的项目（编号、内容一致）。</b>
          <p class="small" style="margin: 4px 0 0">同一份文件重复导入不会写成两版，本次无需写入。</p>
        </template>
        <template v-else>
          <b>编号冲突：本机已存在项目「{{ importPlan.conflict.existingName }}」（同一编号），请定夺：</b>
          <ul>
            <li v-for="(d, i) in importPlan.conflict.diffs" :key="i">{{ d }}</li>
          </ul>
        </template>
      </div>

      <div class="row" style="margin-top: 12px">
        <template v-if="!importPlan.conflict">
          <button class="primary" @click="confirmImport('new')">确认导入</button>
        </template>
        <template v-else-if="!importPlan.conflict.identical">
          <button class="primary" @click="confirmImport('copy')">保留两份（作为副本导入）</button>
          <button class="ghost-danger" @click="confirmImport('overwrite')">用文件覆盖本机项目</button>
        </template>
        <button @click="cancelImport">
          {{ importPlan.conflict?.identical ? '关闭' : '取消（整批退回）' }}
        </button>
      </div>
    </section>

    <div class="row wrap" style="margin: 16px 0 10px">
      <h2 style="font-size: 16px">项目列表（{{ jobs.length }}）</h2>
      <div class="spacer" />
      <router-link to="/offcuts" class="tag good">可用余料 {{ availableOffcuts }} 块 →</router-link>
      <button class="sm" @click="showSelfTest = !showSelfTest">
        {{ showSelfTest ? '收起' : '运行' }}算法自检（100 组随机断言）
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
          30 件 ≤20 刀且逐刀模拟还原、余料再利用、300 件 &lt;1.5s、微调合法性、存档兼容
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
          <span v-if="job.result?.recomputedAt" class="tag warn">导入重算版</span>
          <span v-else-if="!job.result" class="tag">未排样</span>
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
  margin-top: 14px;
  border-color: var(--c-primary);
}
.import-panel .issue {
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 8px 12px;
  margin-top: 8px;
  font-size: 13px;
}
.import-panel .issue ul {
  margin: 6px 0 0;
  padding-left: 20px;
}
.import-panel .issue li {
  margin: 2px 0;
}
.import-panel .issue.warn {
  background: #fffbeb;
  border-color: #f0d9b5;
  color: #92600a;
}
.import-panel .issue.bad {
  background: var(--c-bad-bg);
  border-color: #eecfcf;
  color: var(--c-bad);
}
.import-panel code {
  background: #f1f4f1;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12px;
}
.import-panel code.unk {
  display: inline-block;
  margin: 4px 6px 0 0;
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
