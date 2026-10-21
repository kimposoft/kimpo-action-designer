<script setup lang="ts">
import { computed } from 'vue';
import { t as $t } from '../i18n';

/**
 * 表单操作（ui.form_control）专用配置面板——Kimpo 设计层动作设计器 NodeConfigDialog 的
 * x-editor:form-control 特化渲染。
 *
 * 单步骤：选择要对当前表单执行的操作（保存/关闭/进入编辑三选一大卡片，选中=浅蓝底+品牌
 * 描边+右上角勾角标，与联动表单面板②的卡片同一设计语言）；选中后在卡片下方给出该操作的
 * 实际效果与风险说明。框架级「异步执行」开关统一由 NodeConfigDialog 头部「选项」按钮承载
 * （面板自身不再提供第二个「选项」入口）。
 *
 * 产物落 draft.params（经 patch 事件由 NodeConfigDialog 合并）：op = save | close | edit。
 */
const props = defineProps<{
  params: Record<string, unknown>;
}>();

const emit = defineEmits<{
  patch: [partial: Record<string, unknown>];
}>();

type FormControlOp = 'save' | 'close' | 'edit';

/** 当前选中的操作（params 为权威，面板无独立草稿）；历史脏数据容错为未选。 */
const currentOp = computed<FormControlOp | ''>(() => {
  const op = props.params.op;
  return op === 'save' || op === 'close' || op === 'edit' ? op : '';
});

/** 三张操作卡片（顺序：保存/关闭/进入编辑）。 */
const opCards = computed(() =>
  (['save', 'close', 'edit'] as const).map(op => ({
    op,
    title: $t(`actionDesigner.dialog.formControl.${op}Card`),
    desc: $t(`actionDesigner.dialog.formControl.${op}CardDesc`),
    summary: $t(`actionDesigner.dialog.formControl.${op}Summary`)
  }))
);

/** 选中操作后的效果与风险说明（步骤副标题承诺的「下方说明」）。 */
const currentSummary = computed(() => {
  const card = opCards.value.find(c => c.op === currentOp.value);
  return card?.summary ?? '';
});

function selectOp(op: FormControlOp): void {
  emit('patch', { op });
}
</script>

<template>
  <div class="fc-panel">
    <!-- 单步骤：左轨圆点（恒为当前步=品牌色）+ 标题/副标题 + 三卡片 -->
    <div class="fc-step-row">
      <div class="fc-rail">
        <span class="fc-dot">1</span>
      </div>
      <div class="fc-section">
        <div class="fc-title">{{ $t('actionDesigner.dialog.formControl.title') }}</div>
        <div class="fc-hint">{{ $t('actionDesigner.dialog.formControl.hint') }}</div>
        <div class="fc-cards">
          <button
            v-for="card in opCards"
            :key="card.op"
            type="button"
            class="fc-card"
            :class="{ selected: currentOp === card.op }"
            :aria-pressed="currentOp === card.op"
            :data-testid="`form-control-op-${card.op}`"
            @click="selectOp(card.op)"
          >
            <span class="fc-card-icon">
              <!-- 图标为线稿，currentColor 跟随品牌色 -->
              <svg v-if="card.op === 'save'" viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
                <path
                  d="M3 1.5C2.60218 1.5 2.22064 1.65804 1.93934 1.93934C1.65804 2.22064 1.5 2.60218 1.5 3V21C1.5 21.3978 1.65804 21.7794 1.93934 22.0607C2.22064 22.342 2.60218 22.5 3 22.5H21C21.3978 22.5 21.7794 22.342 22.0607 22.0607C22.342 21.7794 22.5 21.3978 22.5 21V3C22.5 2.60218 22.342 2.22064 22.0607 1.93934C21.7794 1.65804 21.3978 1.5 21 1.5H3ZM3 0H21C21.7956 0 22.5587 0.316071 23.1213 0.87868C23.6839 1.44129 24 2.20435 24 3V21C24 21.7956 23.6839 22.5587 23.1213 23.1213C22.5587 23.6839 21.7956 24 21 24H3C2.20435 24 1.44129 23.6839 0.87868 23.1213C0.316071 22.5587 0 21.7956 0 21V3C0 2.20435 0.316071 1.44129 0.87868 0.87868C1.44129 0.316071 2.20435 0 3 0Z"
                  fill="currentColor"
                />
                <path
                  d="M5.25 1.5V6C5.25 6.39782 5.40804 6.77936 5.68934 7.06066C5.97064 7.34196 6.35218 7.5 6.75 7.5H17.25C17.6478 7.5 18.0294 7.34196 18.3107 7.06066C18.592 6.77936 18.75 6.39782 18.75 6V1.5H5.25ZM3.75 0H20.25V6C20.25 6.79565 19.9339 7.55871 19.3713 8.12132C18.8087 8.68393 18.0456 9 17.25 9H6.75C5.95435 9 5.19129 8.68393 4.62868 8.12132C4.06607 7.55871 3.75 6.79565 3.75 6V0Z"
                  fill="currentColor"
                />
                <path
                  d="M15.75 3.75C15.75 3.55109 15.829 3.36032 15.9697 3.21967C16.1103 3.07902 16.3011 3 16.5 3C16.6989 3 16.8897 3.07902 17.0303 3.21967C17.171 3.36032 17.25 3.55109 17.25 3.75V5.25C17.25 5.44891 17.171 5.63968 17.0303 5.78033C16.8897 5.92098 16.6989 6 16.5 6C16.3011 6 16.1103 5.92098 15.9697 5.78033C15.829 5.63968 15.75 5.44891 15.75 5.25V3.75Z"
                  fill="currentColor"
                />
              </svg>
              <svg v-else-if="card.op === 'close'" viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
                <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="1.25" stroke="currentColor" stroke-width="1.5" />
                <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
                <path
                  d="M13.5 2H3C1.89543 2 1 2.89543 1 4V21C1 22.1046 1.89543 23 3 23H20C21.1046 23 22 22.1046 22 21V11.2791"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
                <path
                  d="M19.6135 1.23744L22.4061 4.02996C22.5036 4.12759 22.5037 4.2859 22.4061 4.38351L11.0723 15.7172C11.0255 15.7639 10.9617 15.7904 10.8956 15.7904H8.10304C7.96522 15.7903 7.85326 15.6783 7.85306 15.5405V12.7479C7.85306 12.6818 7.87956 12.618 7.92626 12.5712L19.26 1.23744C19.3576 1.13981 19.5159 1.13981 19.6135 1.23744Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                />
              </svg>
            </span>
            <strong>{{ card.title }}</strong>
            <small>{{ card.desc }}</small>
            <span v-if="currentOp === card.op" class="fc-card-check">✓</span>
          </button>
        </div>
        <div v-if="currentSummary" class="fc-summary" data-testid="form-control-summary">{{ currentSummary }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fc-panel {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 4px 16px;
}

/* 步骤行：左轨圆点 + 右内容（单步骤，圆点恒为品牌色无连线） */
.fc-step-row {
  display: flex;
  gap: 16px;
}
.fc-rail {
  flex: 0 0 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.fc-dot {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background-color: rgb(var(--primary-color));
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.fc-section {
  flex: 1 1 auto;
  min-width: 0;
}
.fc-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: rgb(var(--base-text-color));
}
.fc-hint {
  font-size: 12px;
  color: rgb(var(--text-hint-color));
  margin: 8px 0 0;
}

/* 操作卡片（280×180 居中排版，间距 36；选中=浅蓝底+品牌描边+右上角勾角标） */
.fc-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 36px;
  margin-top: 24px;
}
.fc-card {
  position: relative;
  width: 280px;
  height: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  border: 1px solid rgb(var(--border-color));
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: center;
  overflow: hidden;
}
.fc-card:hover {
  border-color: rgb(var(--primary-color) / 0.6);
}
.fc-card.selected {
  border-color: rgb(var(--primary-color));
  background-color: rgb(var(--primary-50-color) / 0.5);
}
/* 图标容器（48×48：浅蓝底圆角块 + 24px 品牌色线稿；选中时底色加深为不透明浅蓝） */
.fc-card-icon {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  background-color: rgb(var(--primary-50-color) / 0.5);
  color: rgb(var(--primary-color));
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.fc-card.selected .fc-card-icon {
  background-color: rgb(var(--primary-50-color));
}
.fc-card strong {
  font-size: 14px;
  font-weight: 500;
  line-height: normal;
  color: rgb(var(--base-text-color));
}
.fc-card small {
  font-size: 12px;
  color: rgb(var(--text-secondary-color));
}
/* 右上角勾选角标：品牌色三角 + 白勾（与联动表单卡片同款） */
.fc-card-check {
  position: absolute;
  top: 0;
  right: 0;
  width: 24px;
  height: 24px;
  background: linear-gradient(225deg, rgb(var(--primary-color)) 50%, transparent 50%);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 3px 4px 0 0;
  box-sizing: border-box;
}

/* 选中后的效果与风险说明（步骤副标题承诺的「下方说明」区 预留位） */
.fc-summary {
  margin-top: 16px;
  font-size: 12px;
  color: rgb(var(--text-secondary-color));
}
</style>
