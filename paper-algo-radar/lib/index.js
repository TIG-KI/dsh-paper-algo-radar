/**
 * 论文算法雷达（Paper Algorithm Radar）— Host half.
 *
 * 职责：
 *  1. 持久化：papers / algorithms / mentions / meta 四类记录，落在 DSH_HOME 下的 JSON 快照。
 *  2. 词典层抽取：确定性正则扫描，统计算法出现次数、所在章节、证据片段。
 *  3. 聚合：论文数 / 提及数 / 首见年份 / 最后年份 / 领域分布，按需现算。
 *  4. 对外能力：两个 Agent 工具 + 面板取数的 HTTP 接口。
 *
 * 设计取舍：
 *  - 只存事实（论文、算法、mention），排行永远现算：词典扩充或别名合并后历史统计可完整重算。
 *  - 只用 Node 内建模块，不依赖任何 Harness 包。工作区目录安装的 bundle 是符号链接，
 *    裸包名（@deepseek-ai/*）在工作区路径下无法解析，零依赖是这种安装方式下唯一稳妥的做法。
 */
import { copyFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildMatchers, extract, codePointLength } from './extract.js'
import { migrateSnapshot, SCHEMA_VERSION } from './migrate.js'
import { boundResult, clampInt, compareCodePoints, paginate, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from './contract.js'
import { RadarError, toErrorPayload, toHttpError } from './errors.js'
import { readText, removeText, writeText } from './texts.js'
import { analyzeText, sanitizeText } from './textquality.js'
import { planImport } from './importer.js'
import { discover as discoverSources, fetchArxivFullText, resolveArxiv, resolveDoi } from './sources.js'
import { registerRadarCommand } from './command.js'
import { describeApprovalVerdict, requestWriteApproval } from './approval.js'
import { UndoStack } from './undo.js'
import { backupStatus, maybeDailyBackup } from './backup.js'
import { addCandidate, candidateStats, listCandidates, markCandidateApproved, rejectCandidate } from './candidates.js'
import { extractPdfInWorker } from './pdfrun.js'
import {
  addDictEntry,
  dictEntries,
  dictVersionOf,
  matchersFor,
  moveDictAlias,
  removeDictEntry,
  SEED_DICT_VERSION,
  updateDictEntry,
} from './dict.js'
import {
  newPaperId,
  normalizeDoi,
  normalizeTitleKey,
  looksLikeArxiv,
  normalizeArxivId,
  paperKeysOf,
} from './keys.js'

export const name = 'paper-algo-radar'
export const inject = ['tools']

/** 面板与工具共用：算法类型的中文标签（客户端也有一份同义映射）。 */
const TYPE_LABELS = { DL: '深度学习', ML: '机器学习', MATH: '数学与优化' }

/**
 * 词典版本（§8 R8.2）。种子词典随包发布，**改词典才升版本**；
 * 每条提及都写这个值，用来识别「旧口径」并支持原地重算。
 */
const DICT_VERSION = SEED_DICT_VERSION

/* ------------------------------------------------------------------ *
 * 种子词典
 * 每条：id（稳定 slug）/ name（规范名）/ type / family / aliases（含中英别名）
 * 新增条目是安全的：新 id 会在下次激活时自动补进 algorithms。
 * ------------------------------------------------------------------ */
const LEXICON = [
  // 深度学习 · 架构与模型
  { id: 'transformer', name: 'Transformer', type: 'DL', family: '架构', aliases: ['transformer', 'transformers', 'transformer模型'] },
  { id: 'attention', name: '注意力机制', type: 'DL', family: '架构', aliases: ['attention mechanism', 'self-attention', 'self attention', 'cross-attention', 'multi-head attention', 'scaled dot-product attention', '注意力机制', '自注意力', '多头注意力'] },
  { id: 'cnn', name: 'CNN', type: 'DL', family: '架构', aliases: ['cnn', 'convolutional neural network', 'convolutional neural networks', 'convnet', '卷积神经网络'] },
  { id: 'resnet', name: 'ResNet', type: 'DL', family: '架构', aliases: ['resnet', 'resnet-50', 'resnet50', 'resnet-101', 'residual network'] },
  { id: 'vgg', name: 'VGG', type: 'DL', family: '架构', aliases: ['vgg', 'vgg-16', 'vgg-19', 'vgg16'] },
  { id: 'densenet', name: 'DenseNet', type: 'DL', family: '架构', aliases: ['densenet'] },
  { id: 'mobilenet', name: 'MobileNet', type: 'DL', family: '架构', aliases: ['mobilenet', 'mobilenetv2', 'mobilenetv3'] },
  { id: 'efficientnet', name: 'EfficientNet', type: 'DL', family: '架构', aliases: ['efficientnet'] },
  { id: 'vit', name: 'ViT', type: 'DL', family: '架构', aliases: ['vit', 'vision transformer', 'vision transformers'] },
  { id: 'bert', name: 'BERT', type: 'DL', family: '架构', aliases: ['bert', 'bert-base', 'roberta'] },
  { id: 'gpt', name: 'GPT', type: 'DL', family: '架构', aliases: ['gpt', 'gpt-2', 'gpt-3', 'gpt-4', 'generative pre-trained transformer'] },
  { id: 'llm', name: '大语言模型', type: 'DL', family: '生成', aliases: ['llm', 'llms', 'large language model', 'large language models', '大语言模型', '大模型'] },
  { id: 't5', name: 'T5', type: 'DL', family: '架构', aliases: ['t5', 'text-to-text transfer transformer'] },
  { id: 'lstm', name: 'LSTM', type: 'DL', family: '架构', aliases: ['lstm', 'long short-term memory', '长短期记忆网络', '长短期记忆'] },
  { id: 'gru', name: 'GRU', type: 'DL', family: '架构', aliases: ['gru', 'gated recurrent unit', '门控循环单元'] },
  { id: 'rnn', name: 'RNN', type: 'DL', family: '架构', aliases: ['rnn', 'rnns', 'recurrent neural network', 'recurrent neural networks', '循环神经网络'] },
  { id: 'mlp', name: 'MLP', type: 'DL', family: '架构', aliases: ['mlp', 'mlps', 'multi-layer perceptron', 'multilayer perceptron', '多层感知机'] },
  { id: 'unet', name: 'U-Net', type: 'DL', family: '架构', aliases: ['u-net', 'unet'] },
  { id: 'gan', name: 'GAN', type: 'DL', family: '生成', aliases: ['gan', 'gans', 'generative adversarial network', 'generative adversarial networks', '生成对抗网络'] },
  { id: 'vae', name: 'VAE', type: 'DL', family: '生成', aliases: ['vae', 'vaes', 'variational autoencoder', '变分自编码器'] },
  { id: 'diffusion', name: '扩散模型', type: 'DL', family: '生成', aliases: ['diffusion model', 'diffusion models', 'denoising diffusion', 'ddpm', 'stable diffusion', 'score-based model', '扩散模型'] },
  { id: 'flow-matching', name: 'Flow Matching', type: 'DL', family: '生成', aliases: ['flow matching', 'rectified flow'] },
  { id: 'normalizing-flow', name: '标准化流', type: 'DL', family: '生成', aliases: ['normalizing flow', 'normalizing flows', '标准化流'] },
  { id: 'autoencoder', name: '自编码器', type: 'DL', family: '生成', aliases: ['autoencoder', 'auto-encoder', 'autoencoders', '自编码器'] },
  { id: 'moe', name: 'MoE', type: 'DL', family: '架构', aliases: ['moe', 'mixture of experts', 'mixture-of-experts', '专家混合'] },
  { id: 'lora', name: 'LoRA', type: 'DL', family: '训练', aliases: ['lora', 'low-rank adaptation', '低秩适配'] },
  { id: 'peft', name: '参数高效微调', type: 'DL', family: '训练', aliases: ['parameter-efficient fine-tuning', 'parameter efficient fine-tuning', 'peft', 'prefix tuning', 'prompt tuning', '参数高效微调'] },
  { id: 'mamba', name: 'Mamba', type: 'DL', family: '架构', aliases: ['mamba', 'state space model', 'state space models', 'ssm'] },
  { id: 'gnn', name: 'GNN', type: 'DL', family: '图', aliases: ['gnn', 'gnns', 'graph neural network', 'graph neural networks', '图神经网络'] },
  { id: 'gcn', name: 'GCN', type: 'DL', family: '图', aliases: ['gcn', 'graph convolutional network', 'graph convolutional networks'] },
  { id: 'gat', name: 'GAT', type: 'DL', family: '图', aliases: ['gat', 'graph attention network'] },
  { id: 'graphsage', name: 'GraphSAGE', type: 'DL', family: '图', aliases: ['graphsage', 'graph sage'] },
  { id: 'pointnet', name: 'PointNet', type: 'DL', family: '架构', aliases: ['pointnet', 'pointnet++'] },
  { id: 'clip', name: 'CLIP', type: 'DL', family: '多模态', aliases: ['clip', 'contrastive language-image pre-training'] },
  { id: 'contrastive', name: '对比学习', type: 'DL', family: '训练', aliases: ['contrastive learning', '对比学习'] },
  { id: 'simclr', name: 'SimCLR', type: 'DL', family: '训练', aliases: ['simclr'] },
  { id: 'masked-autoencoding', name: '掩码自编码', type: 'DL', family: '训练', aliases: ['masked autoencoder', 'masked autoencoding', 'masked language modeling', '掩码语言模型'] },
  { id: 'knowledge-distillation', name: '知识蒸馏', type: 'DL', family: '训练', aliases: ['knowledge distillation', '知识蒸馏'] },
  { id: 'rag', name: 'RAG', type: 'DL', family: '检索', aliases: ['rag', 'retrieval-augmented generation', 'retrieval augmented generation', '检索增强生成'] },
  { id: 'rlhf', name: 'RLHF', type: 'DL', family: '强化', aliases: ['rlhf', 'reinforcement learning from human feedback'] },
  { id: 'dpo', name: 'DPO', type: 'DL', family: '强化', aliases: ['dpo', 'direct preference optimization'] },
  // 强化学习
  { id: 'ppo', name: 'PPO', type: 'DL', family: '强化', aliases: ['ppo', 'proximal policy optimization'] },
  { id: 'sac', name: 'SAC', type: 'DL', family: '强化', aliases: ['sac', 'soft actor-critic'] },
  { id: 'dqn', name: 'DQN', type: 'DL', family: '强化', aliases: ['dqn', 'deep q-network', 'deep q-learning'] },
  { id: 'td3', name: 'TD3', type: 'DL', family: '强化', aliases: ['td3', 'twin delayed deep deterministic'] },
  { id: 'a3c', name: 'A3C', type: 'DL', family: '强化', aliases: ['a3c', 'advantage actor-critic'] },
  { id: 'alphazero', name: 'AlphaZero', type: 'DL', family: '强化', aliases: ['alphazero', 'alpha zero'] },
  { id: 'mcts', name: '蒙特卡洛树搜索', type: 'DL', family: '强化', aliases: ['mcts', 'monte carlo tree search', '蒙特卡洛树搜索'] },
  // 机器学习 · 传统方法
  { id: 'svm', name: 'SVM', type: 'ML', family: '分类', aliases: ['svm', 'svms', 'support vector machine', 'support vector machines', '支持向量机'] },
  { id: 'random-forest', name: '随机森林', type: 'ML', family: '集成', aliases: ['random forest', 'random forests', '随机森林'] },
  { id: 'xgboost', name: 'XGBoost', type: 'ML', family: '集成', aliases: ['xgboost'] },
  { id: 'lightgbm', name: 'LightGBM', type: 'ML', family: '集成', aliases: ['lightgbm'] },
  { id: 'catboost', name: 'CatBoost', type: 'ML', family: '集成', aliases: ['catboost'] },
  { id: 'gbdt', name: 'GBDT', type: 'ML', family: '集成', aliases: ['gbdt', 'gradient boosting', 'gradient boosted decision tree', '梯度提升树'] },
  { id: 'decision-tree', name: '决策树', type: 'ML', family: '分类', aliases: ['decision tree', 'decision trees', '决策树'] },
  { id: 'knn', name: 'KNN', type: 'ML', family: '分类', aliases: ['knn', 'k-nearest neighbor', 'k-nearest neighbours', 'k近邻'] },
  { id: 'kmeans', name: 'K-Means', type: 'ML', family: '聚类', aliases: ['k-means', 'kmeans', 'k均值'] },
  { id: 'dbscan', name: 'DBSCAN', type: 'ML', family: '聚类', aliases: ['dbscan'] },
  { id: 'gmm', name: 'GMM', type: 'ML', family: '聚类', aliases: ['gmm', 'gaussian mixture model', '高斯混合模型'] },
  { id: 'pca', name: 'PCA', type: 'ML', family: '降维', aliases: ['pca', 'principal component analysis', '主成分分析'] },
  { id: 'tsne', name: 't-SNE', type: 'ML', family: '降维', aliases: ['t-sne', 'tsne'] },
  { id: 'umap', name: 'UMAP', type: 'ML', family: '降维', aliases: ['umap'] },
  { id: 'lda-topic', name: 'LDA（主题模型）', type: 'ML', family: '统计', aliases: ['lda', 'latent dirichlet allocation', '隐含狄利克雷分布'] },
  { id: 'logistic-regression', name: '逻辑回归', type: 'ML', family: '分类', aliases: ['logistic regression', '逻辑回归'] },
  { id: 'linear-regression', name: '线性回归', type: 'ML', family: '回归', aliases: ['linear regression', '线性回归'] },
  { id: 'ridge', name: 'Ridge 回归', type: 'ML', family: '回归', aliases: ['ridge regression', '岭回归'] },
  { id: 'lasso', name: 'Lasso', type: 'ML', family: '回归', aliases: ['lasso', 'lasso regression'] },
  { id: 'bayesian-network', name: '贝叶斯网络', type: 'ML', family: '统计', aliases: ['bayesian network', 'bayesian networks', '贝叶斯网络'] },
  { id: 'hmm', name: 'HMM', type: 'ML', family: '统计', aliases: ['hmm', 'hidden markov model', '隐马尔可夫模型'] },
  { id: 'crf', name: 'CRF', type: 'ML', family: '统计', aliases: ['crf', 'conditional random field', '条件随机场'] },
  { id: 'ensemble', name: '集成学习', type: 'ML', family: '集成', aliases: ['ensemble learning', 'ensemble method', 'boosting', 'bagging', 'stacking', '集成学习'] },
  { id: 'transfer-learning', name: '迁移学习', type: 'ML', family: '训练', aliases: ['transfer learning', '迁移学习'] },
  { id: 'meta-learning', name: '元学习', type: 'ML', family: '训练', aliases: ['meta-learning', 'meta learning', 'learning to learn', '元学习'] },
  { id: 'active-learning', name: '主动学习', type: 'ML', family: '训练', aliases: ['active learning', '主动学习'] },
  { id: 'semi-supervised', name: '半监督学习', type: 'ML', family: '训练', aliases: ['semi-supervised learning', '半监督学习'] },
  { id: 'self-supervised', name: '自监督学习', type: 'ML', family: '训练', aliases: ['self-supervised learning', '自监督学习'] },
  { id: 'federated', name: '联邦学习', type: 'ML', family: '训练', aliases: ['federated learning', '联邦学习'] },
  // 数学 · 优化与统计
  { id: 'gd', name: '梯度下降', type: 'MATH', family: '优化', aliases: ['gradient descent', 'batch gradient descent', '梯度下降'] },
  { id: 'sgd', name: 'SGD', type: 'MATH', family: '优化', aliases: ['sgd', 'stochastic gradient descent', '随机梯度下降'] },
  { id: 'adam', name: 'Adam', type: 'MATH', family: '优化', aliases: ['adam', 'adamw'] },
  { id: 'rmsprop', name: 'RMSprop', type: 'MATH', family: '优化', aliases: ['rmsprop'] },
  { id: 'newton', name: '牛顿法', type: 'MATH', family: '优化', aliases: ['newton method', "newton's method", '牛顿法'] },
  { id: 'lbfgs', name: 'L-BFGS', type: 'MATH', family: '优化', aliases: ['l-bfgs', 'lbfgs', 'bfgs', '拟牛顿法'] },
  { id: 'convex-optimization', name: '凸优化', type: 'MATH', family: '优化', aliases: ['convex optimization', 'convex optimization problem', '凸优化'] },
  { id: 'lagrangian', name: '拉格朗日乘子法', type: 'MATH', family: '优化', aliases: ['lagrangian multiplier', 'lagrange multiplier', 'lagrangian duality', '拉格朗日乘子', '对偶问题'] },
  { id: 'interior-point', name: '内点法', type: 'MATH', family: '优化', aliases: ['interior point method', 'interior-point method', '内点法'] },
  { id: 'dynamic-programming', name: '动态规划', type: 'MATH', family: '优化', aliases: ['dynamic programming', '动态规划'] },
  // 数学 · 智能优化（元启发式）：论文里缩写与全称混用，别名一律小写——
  // 大写缩写（GA / PSO）会触发 R6.5 的条目级大小写敏感，反而漏掉 "Genetic Algorithm"。
  { id: 'genetic-algorithm', name: '遗传算法', type: 'MATH', family: '智能优化', aliases: ['genetic algorithm', '遗传算法', '遗传优化', 'ga'] },
  { id: 'particle-swarm', name: '粒子群优化', type: 'MATH', family: '智能优化', aliases: ['particle swarm optimization', 'particle swarm optimisation', 'particle swarm', '粒子群优化', '粒子群算法', '粒子群', 'pso'] },
  { id: 'bat-algorithm', name: '蝙蝠算法', type: 'MATH', family: '智能优化', aliases: ['bat algorithm', 'bat-inspired algorithm', '蝙蝠算法', 'ba'] },
  { id: 'simulated-annealing', name: '模拟退火', type: 'MATH', family: '智能优化', aliases: ['simulated annealing', '模拟退火', '模拟退火算法', '退火算法', 'sa'] },
  { id: 'ant-colony', name: '蚁群优化', type: 'MATH', family: '智能优化', aliases: ['ant colony optimization', 'ant colony optimisation', 'ant colony system', '蚁群算法', '蚁群优化', 'aco'] },
  { id: 'differential-evolution', name: '差分进化', type: 'MATH', family: '智能优化', aliases: ['differential evolution', 'differential evolution algorithm', '差分进化', '差分进化算法'] },
  { id: 'grey-wolf', name: '灰狼优化', type: 'MATH', family: '智能优化', aliases: ['grey wolf optimizer', 'gray wolf optimizer', 'grey wolf optimization', 'gray wolf optimization', '灰狼优化', '灰狼算法', 'gwo'] },
  { id: 'whale-optimization', name: '鲸鱼优化', type: 'MATH', family: '智能优化', aliases: ['whale optimization algorithm', 'whale optimization', '鲸鱼优化', '鲸鱼优化算法', 'woa'] },
  { id: 'sparrow-search', name: '麻雀搜索', type: 'MATH', family: '智能优化', aliases: ['sparrow search algorithm', 'sparrow search', '麻雀搜索', '麻雀搜索算法', 'ssa'] },
  { id: 'harris-hawks', name: '哈里斯鹰优化', type: 'MATH', family: '智能优化', aliases: ['harris hawks optimization', 'harris hawk optimization', '哈里斯鹰优化', '哈里斯鹰算法', 'hho'] },
  { id: 'artificial-bee-colony', name: '人工蜂群', type: 'MATH', family: '智能优化', aliases: ['artificial bee colony', 'artificial bee colony algorithm', '人工蜂群', '人工蜂群算法', 'abc'] },
  { id: 'moth-flame', name: '飞蛾扑火优化', type: 'MATH', family: '智能优化', aliases: ['moth-flame optimization', 'moth flame optimization', '飞蛾扑火算法', '飞蛾扑火优化', 'mfo'] },
  { id: 'multi-verse', name: '多元宇宙优化', type: 'MATH', family: '智能优化', aliases: ['multi-verse optimizer', 'multiverse optimizer', '多元宇宙优化', '多元宇宙优化算法', 'mvo'] },
  { id: 'tlbo', name: '教与学优化', type: 'MATH', family: '智能优化', aliases: ['teaching-learning-based optimization', 'teaching learning based optimization', '教与学优化算法', '教与学优化', 'tlbo'] },
  { id: 'jaya', name: 'Jaya 算法', type: 'MATH', family: '智能优化', aliases: ['jaya algorithm', 'jaya', 'jaya 算法'] },
  { id: 'gravitational-search', name: '引力搜索', type: 'MATH', family: '智能优化', aliases: ['gravitational search algorithm', '引力搜索算法', '引力搜索', 'gsa'] },
  { id: 'firefly', name: '萤火虫算法', type: 'MATH', family: '智能优化', aliases: ['firefly algorithm', '萤火虫算法'] },
  { id: 'cuckoo-search', name: '布谷鸟搜索', type: 'MATH', family: '智能优化', aliases: ['cuckoo search', 'cuckoo search algorithm', '布谷鸟搜索', '布谷鸟算法'] },
  { id: 'em', name: 'EM 算法', type: 'MATH', family: '统计', aliases: ['expectation-maximization', 'expectation maximization', 'em algorithm', '最大期望算法'] },
  { id: 'variational-inference', name: '变分推断', type: 'MATH', family: '统计', aliases: ['variational inference', 'variational bayes', '变分推断'] },
  { id: 'mcmc', name: 'MCMC', type: 'MATH', family: '统计', aliases: ['mcmc', 'markov chain monte carlo', '马尔可夫链蒙特卡洛'] },
  { id: 'gibbs', name: '吉布斯采样', type: 'MATH', family: '统计', aliases: ['gibbs sampling', 'gibbs sampler', '吉布斯采样'] },
  { id: 'particle-filter', name: '粒子滤波', type: 'MATH', family: '统计', aliases: ['particle filter', 'particle filtering', '粒子滤波'] },
  { id: 'kalman', name: '卡尔曼滤波', type: 'MATH', family: '统计', aliases: ['kalman filter', '卡尔曼滤波'] },
  { id: 'svd', name: 'SVD', type: 'MATH', family: '线性代数', aliases: ['svd', 'singular value decomposition', '奇异值分解'] },
  { id: 'matrix-factorization', name: '矩阵分解', type: 'MATH', family: '线性代数', aliases: ['matrix factorization', 'matrix decomposition', '矩阵分解'] },
  { id: 'tensor-decomposition', name: '张量分解', type: 'MATH', family: '线性代数', aliases: ['tensor decomposition', 'tensor factorization', '张量分解'] },
  { id: 'fourier', name: '傅里叶变换', type: 'MATH', family: '变换', aliases: ['fourier transform', 'fast fourier transform', 'fft', '傅里叶变换'] },
  { id: 'wavelet', name: '小波变换', type: 'MATH', family: '变换', aliases: ['wavelet transform', 'wavelet', '小波变换'] },
  { id: 'mle', name: '最大似然估计', type: 'MATH', family: '统计', aliases: ['maximum likelihood estimation', 'maximum likelihood estimate', '最大似然估计', '极大似然估计'] },
  { id: 'map', name: '最大后验估计', type: 'MATH', family: '统计', aliases: ['maximum a posteriori', '最大后验估计'] },
  { id: 'bayes-theorem', name: '贝叶斯定理', type: 'MATH', family: '统计', aliases: ['bayes theorem', 'bayes rule', "bayes' theorem", '贝叶斯定理', '贝叶斯公式'] },
  { id: 'kl', name: 'KL 散度', type: 'MATH', family: '信息论', aliases: ['kl divergence', 'kullback-leibler divergence', 'kl散度', '相对熵'] },
  { id: 'cross-entropy', name: '交叉熵', type: 'MATH', family: '信息论', aliases: ['cross-entropy', 'cross entropy', '交叉熵'] },
  { id: 'graph-cut', name: '图割', type: 'MATH', family: '图论', aliases: ['graph cut', 'graph cuts', '图割'] },
  { id: 'spectral-method', name: '谱方法', type: 'MATH', family: '图论', aliases: ['spectral clustering', 'spectral method', '谱聚类', '谱方法'] },
]

/* ------------------------------------------------------------------ *
 * 匹配器
 * ------------------------------------------------------------------ */

/** 词典 → 匹配表。匹配规则全部在 lib/extract.js（纯函数，§8 R6）。 */
/** 种子匹配器；运行时以快照里的词典为准（见 activeMatchers）。 */
const SEED_MATCHERS = buildMatchers(LEXICON)

/** 当前生效的匹配器（用户改过词典就用改后的）。 */
function activeMatchers(store) {
  return matchersFor(store, LEXICON)
}

/* ------------------------------------------------------------------ *
 * 文本处理
 * ------------------------------------------------------------------ */

// 抽取相关实现（normalizeText / stripArtifacts / cutReferences / 章节切分 / extract）
// 已整体移到 lib/extract.js。这里不再保留第二份实现。


/* ------------------------------------------------------------------ *
 * 存储：内存 Map + 原子 JSON 快照
 * ------------------------------------------------------------------ */

function resolveStoreFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'paper-algo-radar', 'store.json')
}

class Store {
  constructor(file) {
    this.file = file
    this.papers = new Map()
    this.algorithms = new Map()
    this.mentions = new Map()
    // 三键倒排：doi: / arxiv: / title: → paperId（§9.2）
    this.paperKeys = new Map()
    this.meta = new Map()
    this.writeQueue = Promise.resolve()
    this.counter = 0
    /** 上次 load 时的迁移报告（没有迁移则为 null）。 */
    this.migration = null
    /** 迁移改动了内容，等下一次写入时落盘（加载期不写盘，FR-10.5）。 */
    this.migrationPending = false
  }

  async load() {
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return false
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new RadarError('CORRUPTED_STORE', `算法库文件损坏，无法解析（${this.file}）：${error.message}`)
    }
    // v0.2（version:1）→ 当前版本：口径全在 lib/migrate.js，纯函数、幂等
    const { data, report } = migrateSnapshot(parsed)
    for (const [key, value] of Object.entries(data.papers ?? {})) this.papers.set(key, value)
    for (const [key, value] of Object.entries(data.algorithms ?? {})) this.algorithms.set(key, value)
    for (const [key, value] of Object.entries(data.mentions ?? {})) this.mentions.set(key, value)
    for (const [key, value] of Object.entries(data.meta ?? {})) this.meta.set(key, value)
    for (const [key, value] of Object.entries(data.paperKeys ?? {})) this.paperKeys.set(key, value)
    // 兜底：迁移没产出任何键时再就地重建一次
    if (this.paperKeys.size === 0) this.rebuildPaperKeys()
    this.migration = report
    this.migrationPending = report.changed
    return true
  }

  /** 用现有论文重建三键索引，返回新增键数。 */
  rebuildPaperKeys() {
    let added = 0
    for (const paper of this.papers.values()) added += this.indexPaperKeys(paper)
    return added
  }

  /** 把一篇论文的所有可用键挂进倒排；已属于别的论文的键不抢。 */
  indexPaperKeys(paper) {
    let added = 0
    for (const key of paperKeysOf(paper)) {
      const owner = this.paperKeys.get(key)
      if (owner === paper.id) continue
      if (owner !== undefined) continue
      this.paperKeys.set(key, paper.id)
      added += 1
    }
    return added
  }

  snapshot() {
    return JSON.stringify({
      version: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      papers: Object.fromEntries(this.papers),
      algorithms: Object.fromEntries(this.algorithms),
      mentions: Object.fromEntries(this.mentions),
      paperKeys: Object.fromEntries(this.paperKeys),
      meta: Object.fromEntries(this.meta),
    })
  }

  /**
   * 串行整快照写入：写临时文件 → fsync → 备份旧快照 → rename 原子替换。
   * fsync 之后再 rename，断电也只会看到「旧快照」或「新快照」，不会看到半个文件。
   */
  save() {
    const body = this.snapshot()
    this.counter += 1
    const temporary = `${this.file}.${this.counter}.tmp`
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true })
        const handle = await open(temporary, 'w')
        try {
          await handle.writeFile(body, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        // 备份上一份（首次写入时源文件不存在，忽略即可）
        await copyFile(this.file, `${this.file}.bak`).catch(() => {})
        await rename(temporary, this.file)
      })
    return this.writeQueue
  }
}

/* ------------------------------------------------------------------ *
 * 写入与聚合
 * ------------------------------------------------------------------ */

async function seedAlgorithms(store) {
  let added = 0
  for (const entry of LEXICON) {
    if (store.algorithms.get(entry.id) !== undefined) continue
    store.algorithms.set(entry.id, {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      family: entry.family,
      aliases: entry.aliases,
      status: 'approved',
      origin: 'seed',
    })
    added += 1
  }
  if (added > 0) await store.save()
  return added
}

function normalizeYear(value) {
  const year = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(year)) return null
  if (year < 1900 || year > 2100) return null
  return Math.trunc(year)
}

function normalizeFields(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，;；]/)
  const seen = new Set()
  const fields = []
  for (const item of list) {
    const field = String(item ?? '').trim()
    if (field === '' || seen.has(field)) continue
    seen.add(field)
    fields.push(field.slice(0, 40))
    if (fields.length >= 8) break
  }
  return fields
}

async function ingestPaper(store, input) {
  const depth = input?.depth === 'abstract' ? 'abstract' : 'fulltext'
  // 摘要级登记的中文摘要常常只有一两百字，阈值必须比全文低，否则几乎全被拒。
  const minChars = depth === 'abstract' ? 120 : 300
  // §10.3 PAYLOAD_TOO_LARGE：正文 > 5,000,000 code point 直接拒绝，不静默截断。
  // 先用 UTF-16 长度做零成本预判（code point 数 ≤ UTF-16 长度）。
  const rawText = String(input?.text ?? '')
  if (rawText.length >= 5000000) {
    const cp = codePointLength(rawText)
    if (cp > 5000000) {
      throw new RadarError(
        'PAYLOAD_TOO_LARGE',
        `正文过长（${cp} code point，上限 5,000,000）。请截取正文主体后重试。`,
        { field: 'text' },
      )
    }
  }
  // 闸门：正文必须像自然语言。真实 PDF 里的 CID/Type0 字体、被误当内容流的二进制流，
  // 都会产出「字符很多、没有一个词」的文本——长度校验拦不住，最后以乱码进库。
  // 判定必须在清洗之前（清洗会抹掉控制字符比例这条证据）。
  if (rawText !== '') {
    const health = analyzeText(rawText)
    if (!health.usable) {
      throw new RadarError(
        'VALIDATION',
        `正文不像自然语言（${health.reasons.join('；')}）。这通常是把 PDF / 二进制内容当成正文传进来了：` +
          '请粘贴正文文字，或先用 OCR / 复制文本再登记。',
        { field: 'text' },
      )
    }
  }
  const cleanText = sanitizeText(rawText)
  // 抽取是纯函数（R1–R8 全在 lib/extract.js）：输入原文，拿回统计文本、命中与告警。
  const extracted = extract(cleanText, activeMatchers(store), {
    dictVersion: dictVersionOf(store),
    depth,
    source: input?.source,
  })
  const body = extracted.statsText
  const chars = extracted.chars
  if (chars < minChars) {
    throw new RadarError(
      'VALIDATION',
      depth === 'abstract'
        ? '摘要过短（少于 120 字符），不足以做算法统计。可以补充正文，或换一篇。'
        : '正文过短（少于 300 字符）。请提供论文正文（摘要 + 方法 + 实验），只有标题不足以统计。',
      { field: 'text' },
    )
  }

  const title = String(input?.title ?? '').trim() || '未命名论文'
  const year = normalizeYear(input?.year)
  const venue = String(input?.venue ?? '').trim()
  const doi = looksLikeArxiv(input?.doi) ? '' : normalizeDoi(input?.doi)
  const arxivId = looksLikeArxiv(input?.doi)
    ? normalizeArxivId(input?.doi)
    : normalizeArxivId(input?.arxivId ?? '')
  const fields = normalizeFields(input?.fields)

  const hits = extracted.hits
  const now = Date.now()

  // 三键去重：三个候选键同时查，任一命中即同一篇。
  // 主键不再由「doi|年份|标题」派生 —— 否则补个年份就会变成另一篇（E10）。
  const keys = []
  if (doi !== '') keys.push('doi:' + doi)
  if (arxivId !== '') keys.push('arxiv:' + arxivId)
  const titleKey = normalizeTitleKey(title)
  if (titleKey !== '') keys.push('title:' + titleKey)

  let paperId = ''
  for (const key of keys) {
    const owner = store.paperKeys.get(key)
    if (owner !== undefined && store.papers.has(owner)) {
      paperId = owner
      break
    }
  }
  const existed = paperId !== ''
  if (!existed) paperId = newPaperId()

  const previous = existed ? store.papers.get(paperId) : undefined

  // §8 R11：留存 R1 之后、R3/R4 之前的规范化正文（gzip），供重算与完整导出。
  // 只有正文达标（≥120 cp，上面已校验）才留存；不留存时 hasText=false，重算会跳过它。
  let storedText = { rawChars: 0, textHash: '' }
  let hasText = false
  if (extracted.retainedText !== '') {
    storedText = await writeText(store.file, paperId, extracted.retainedText)
    hasText = true
  }

  store.papers.set(paperId, {
    id: paperId,
    dedupeKey: keys.length > 0 ? keys[0] : '',
    title: title.slice(0, 300),
    // 补登记语义：新值优先，缺省沿用旧值（先无年份、后补年份 → 年份被更新而不是新建一篇）
    year: year ?? previous?.year ?? null,
    venue: venue !== '' ? venue.slice(0, 120) : previous?.venue ?? '',
    doi: doi !== '' ? doi : previous?.doi ?? '',
    arxivId: arxivId !== '' ? arxivId : previous?.arxivId ?? '',
    fields: fields.length > 0 ? fields : previous?.fields ?? ['未分类'],
    depth,
    chars,
    hitCount: hits.length,
    hasText,
    rawChars: storedText.rawChars,
    textHash: storedText.textHash,
    isSample: input?.isSample === true ? true : previous?.isSample ?? false,
    status: previous?.status ?? null,
    readAt: previous?.readAt ?? now,
    updatedAt: now,
  })

  // 重建该论文的键：失效的旧键先摘掉，再挂新键（补 DOI 时不留下悬空映射）
  for (const [key, owner] of [...store.paperKeys.entries()]) {
    if (owner === paperId && !keys.includes(key)) store.paperKeys.delete(key)
  }
  for (const key of keys) store.paperKeys.set(key, paperId)

  const prefix = `${paperId}::`
  for (const key of [...store.mentions.keys()]) {
    if (key.startsWith(prefix)) store.mentions.delete(key)
  }
  for (const hit of hits) {
    store.mentions.set(`${prefix}${hit.id}`, {
      paperId,
      algorithmId: hit.id,
      count: hit.count,
      sections: hit.sections,
      snippets: hit.snippets,
      dictVersion: dictVersionOf(store),
      updatedAt: now,
    })
  }

  store.meta.set('state', { key: 'state', lastScanAt: now, lastPaperId: paperId, schemaVersion: 2 })
  await store.save()

  const saved = store.papers.get(paperId)
  return {
    paper: {
      id: saved.id,
      dedupeKey: saved.dedupeKey,
      title: saved.title,
      year: saved.year,
      venue: saved.venue,
      fields: saved.fields,
      depth: saved.depth,
      // 身份与正文留存状态：不加这几个，调用方无法确认「记的是哪一篇、能不能重算」
      doi: saved.doi ?? '',
      arxivId: saved.arxivId ?? '',
      hasText: saved.hasText === true,
      hitCount: saved.hitCount ?? 0,
    },
    created: !existed,
    hits: hits.map((hit) => ({ id: hit.id, name: hit.name, type: hit.type, count: hit.count })),
    total: hits.length,
    chars,
    depth: saved.depth,
    dictVersion: dictVersionOf(store),
    warnings: extracted.warnings,
    refCut: extracted.refCut,
    refHintEarly: extracted.refHintEarly,
  }
}

function buildState(store, options = {}) {
  const stats = new Map()
  const stalePapers = new Set()
  // 「旧口径且有正文」才是真正可重算的；只有旧口径没有正文的，重算会跳过
  const staleRecomputable = new Set()
  let staleMentions = 0
  // §7 FR-11.2：示例数据默认不计入排行 / 统计 / 趋势 / 覆盖率
  const includeSamples = options.includeSamples === true
  const countsTowardStats = (paper) => includeSamples || paper?.isSample !== true
  let sampleCount = 0
  for (const paper of store.papers.values()) {
    if (paper.isSample === true) sampleCount += 1
  }

  for (const mention of store.mentions.values()) {
    const paper = store.papers.get(mention.paperId)
    if (!countsTowardStats(paper)) continue
    let stat = stats.get(mention.algorithmId)
    if (stat === undefined) {
      stat = { papers: 0, mentions: 0, rawMentions: 0, firstYear: null, lastYear: null, sections: {}, stale: false }
      stats.set(mention.algorithmId, stat)
    }
    // 旧口径（§8 R8.2）：提及的 dictVersion 与当前词典不一致
    if (mention.dictVersion !== dictVersionOf(store)) {
      stat.stale = true
      staleMentions += 1
      stalePapers.add(mention.paperId)
      if (paper?.hasText === true) staleRecomputable.add(mention.paperId)
    }
    stat.papers += 1
    const rawCount = Number(mention.count ?? 0) || 0
    stat.rawMentions += rawCount
    // FR-3.7：封顶只影响「提及数」这一列，论文数与覆盖率口径不变
    stat.mentions += CAP_PER_PAPER > 0 ? Math.min(rawCount, CAP_PER_PAPER) : rawCount
    if (mention.sections !== null && typeof mention.sections === 'object') {
      for (const [rawKey, value] of Object.entries(mention.sections)) {
        // v0.2 写的是 experiments；§8 R5 统一成 experiment。旧提及就地归一，避免同名两列。
        const key = rawKey === 'experiments' ? 'experiment' : rawKey
        stat.sections[key] = (stat.sections[key] ?? 0) + (value ?? 0)
      }
    }
    const year = paper?.year
    if (typeof year === 'number') {
      stat.firstYear = stat.firstYear === null ? year : Math.min(stat.firstYear, year)
      stat.lastYear = stat.lastYear === null ? year : Math.max(stat.lastYear, year)
    }
  }

  const algorithms = []
  for (const [id, stat] of stats.entries()) {
    const record = store.algorithms.get(id)
    algorithms.push({
      id,
      name: record?.name ?? id,
      type: record?.type ?? 'OTHER',
      typeLabel: TYPE_LABELS[record?.type] ?? '其他',
      family: record?.family ?? '',
      papers: stat.papers,
      mentions: stat.mentions,
      rawMentions: stat.rawMentions,
      firstYear: stat.firstYear,
      lastYear: stat.lastYear,
      sections: stat.sections,
      stale: stat.stale === true,
    })
  }
  // §8 G-5：禁用 localeCompare，第三级用码位序（见 lib/contract.js）
  algorithms.sort((a, b) => b.papers - a.papers || b.mentions - a.mentions || compareCodePoints(a.name, b.name))

  const fieldCounts = new Map()
  const perPaper = new Map()
  // 每篇论文的算法类型集合与旧口径标记：面板要用它们算「当前筛选下的分母」（FR-3.4 / FR-3.8）
  const perPaperTypes = new Map()
  const perPaperStale = new Map()
  for (const paper of store.papers.values()) {
    if (!countsTowardStats(paper)) continue
    for (const field of paper.fields ?? []) fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1)
    perPaper.set(paper.id, [])
    perPaperTypes.set(paper.id, new Set())
    perPaperStale.set(paper.id, false)
  }
  for (const mention of store.mentions.values()) {
    const list = perPaper.get(mention.paperId)
    if (list === undefined) continue
    const record = store.algorithms.get(mention.algorithmId) ?? LEXICON_BY_ID.get(mention.algorithmId)
    list.push({ name: record?.name ?? mention.algorithmId, count: mention.count })
    perPaperTypes.get(mention.paperId)?.add(record?.type ?? 'OTHER')
    if (mention.dictVersion !== dictVersionOf(store)) perPaperStale.set(mention.paperId, true)
  }
  for (const list of perPaper.values()) list.sort((a, b) => b.count - a.count)

  const papers = [...store.papers.values()]
    .filter((paper) => countsTowardStats(paper))
    .map((paper) => ({
      id: paper.id,
      title: paper.title,
      year: paper.year,
      venue: paper.venue,
      fields: paper.fields,
      depth: paper.depth === 'abstract' ? 'abstract' : 'fulltext',
      hitCount: paper.hitCount ?? 0,
      hasText: paper.hasText === true,
      types: [...(perPaperTypes.get(paper.id) ?? [])].sort(compareCodePoints),
      stale: perPaperStale.get(paper.id) === true,
      readAt: paper.readAt,
      top: (perPaper.get(paper.id) ?? []).slice(0, 4),
    }))
    .sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0))
    .slice(0, options.paperLimit ?? 60)

  const fields = [...fieldCounts.entries()]
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)

  const mentionCount = algorithms.reduce((sum, item) => sum + item.mentions, 0)
  const rawMentionCount = algorithms.reduce((sum, item) => sum + item.rawMentions, 0)
  const meta = store.meta.get('state')

  return {
    generatedAt: Date.now(),
    paperCount: [...store.papers.values()].filter(countsTowardStats).length,
    algorithmCount: algorithms.length,
    mentionCount,
    rawMentionCount,
    capPerPaper: CAP_PER_PAPER,
    abstractOnlyCount: [...store.papers.values()].filter((paper) => countsTowardStats(paper) && paper.depth === 'abstract').length,
    lastScanAt: meta?.lastScanAt ?? null,
    staleMentions,
    stalePapers: stalePapers.size,
    staleRecomputable: staleRecomputable.size,
    hasTextCount: [...store.papers.values()].filter((paper) => countsTowardStats(paper) && paper.hasText === true).length,
    // 示例数据单独计数：界面要能显示「示例 N 篇（不计入统计）」
    sampleCount,
    includeSamples,
    totalPaperCount: store.papers.size,
    storeFile: store.file,
    schemaVersion: SCHEMA_VERSION,
    dictVersion: dictVersionOf(store),
    tools: REGISTERED_TOOL_NAMES,
    migration: store.migration,
    algorithms,
    papers,
    fields,
  }
}

function dumpAll(store) {
  // §7 FR-7.3：导出必须带 schemaVersion 与 dictVersion，否则导回去没法判断口径
  return {
    schemaVersion: SCHEMA_VERSION,
    dictVersion: dictVersionOf(store),
    exportedAt: new Date().toISOString(),
    papers: [...store.papers.values()],
    algorithms: [...store.algorithms.values()],
    mentions: [...store.mentions.values()],
    paperKeys: [...store.paperKeys.entries()].map(([key, paperId]) => ({ key, paperId })),
    meta: [...store.meta.values()],
  }
}

/** 排行 CSV：带 BOM，Excel 打开中文不乱码。 */
function rankingCsv(store) {
  const state = buildState(store, { paperLimit: 0 })
  const header = ['rank', 'name', 'type', 'family', 'papers', 'mentions', 'coverage', 'firstYear', 'lastYear']
  const rows = state.algorithms.map((item, index) => [
    index + 1,
    item.name,
    item.type,
    item.family,
    item.papers,
    item.mentions,
    state.paperCount > 0 ? (Math.round((item.papers / state.paperCount) * 10000) / 100).toFixed(2) + '%' : '0%',
    item.firstYear ?? '',
    item.lastYear ?? '',
  ])
  const escape = (value) => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
  }
  return '\ufeff' + [header, ...rows].map((row) => row.map(escape).join(',')).join('\n') + '\n'
}

/* ------------------------------------------------------------------ *
 * Agent 工具
 * ------------------------------------------------------------------ */

const ADD_PARAMETERS = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      description:
        '快速添加：给 DOI（10.xxxx/yyy）、arXiv id（2401.12345）或它们的链接即可，插件自己去取元数据与正文。' +
        '与 title+text 二选一；两个都给时用 input。',
    },
    pdfPath: {
      type: 'string',
      description: '本地 PDF 路径（≤20MB）。抽出正文后**不留存 PDF 原件**，只保留规范化正文。扫描件会明确报错。',
    },
    title: { type: 'string', description: '论文标题（粘贴正文时必填）。' },
    text: {
      type: 'string',
      description:
        '论文正文纯文本（摘要 + 方法 + 实验），至少 300 字符（摘要级 120）。只有标题不足以统计。',
    },
    year: {
      type: 'number',
      description: '发表年份，如 2024。可后补：同一篇再次登记会覆盖更新，不会新建一条。',
    },
    venue: { type: 'string', description: '发表会议或期刊，如 "NeurIPS 2024"。' },
    fields: { type: 'string', description: '领域标签，逗号分隔，如 "NLP, Optimization"，最多 8 个。' },
    doi: {
      type: 'string',
      description: 'DOI。若传入的是 arXiv id 或 arXiv 链接，会自动识别成 arXiv 键。',
    },
    arxivId: { type: 'string', description: 'arXiv id（当 doi 位放的是 DOI 时用它）。' },
    depth: {
      type: 'string',
      enum: ['fulltext', 'abstract'],
      description: '统计依据：fulltext（默认）或 abstract（只给了摘要时显式传）。',
    },
    source: {
      type: 'string',
      description: '正文来源标记（pdf / arxiv-html / paste），只用于告警判定，不参与统计。',
    },
  },
  // 两种登记方式二选一，JSON Schema 表达不了 XOR，交给 execute 里的校验给出明确报错
  required: [],
  additionalProperties: false,
}

/** 从用户给的字符串里认出 DOI / arXiv id / 链接。 */
export function parseInputTarget(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') return null

  // arXiv：arxiv.org/abs|pdf|html/xxxx，或 arxiv:xxxx，或裸 id
  const arxivUrl = /arxiv\.org\/(?:abs|pdf|html)\/([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?|[a-z-]+\/[0-9]{7}(?:v[0-9]+)?)/i.exec(raw)
  if (arxivUrl !== null) return { kind: 'arxiv', value: arxivUrl[1].replace(/v[0-9]+$/i, '') }
  const arxivPrefixed = /^arxiv\s*:\s*([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)$/i.exec(raw)
  if (arxivPrefixed !== null) return { kind: 'arxiv', value: arxivPrefixed[1].replace(/v[0-9]+$/i, '') }
  if (/^[0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?$/.test(raw)) return { kind: 'arxiv', value: raw.replace(/v[0-9]+$/i, '') }

  // DOI：10.xxxx/yyy，或 doi.org/10.xxxx/yyy，或 doi:10.xxxx/yyy
  const doiUrl = /(?:doi\.org\/|doi\s*:\s*|^)(10\.[0-9]{4,9}\/[^\s?#]+)/i.exec(raw)
  if (doiUrl !== null) return { kind: 'doi', value: doiUrl[1] }

  if (/^https?:\/\//i.test(raw)) return { kind: 'url', value: raw }
  return null
}

/**
 * `radar_add` —— 登记一篇论文（正文粘贴路径）。
 * 铁律：返回体里**不含正文**，只有命中、字符数、深度与告警（§8 R12 / P-6）。
 */
function buildAddTool(getStore) {
  return {
    name: 'radar_add',
    description:
      '把一篇论文的正文登记进「论文算法雷达」：用内置词典统计正文里出现的机器学习 / 深度学习 / 数学模型算法（含次数与章节），写入算法库。' +
      '返回命中的算法、字符数、深度与告警，**不回显正文**。' +
      '两种用法：① 粘贴正文（title + text）；② 快速添加（只给 input：DOI / arXiv id / 链接，插件自己去取）。' +
      '同一篇论文（DOI / arXiv / 规范化标题 任一相同）再次登记会覆盖更新，不会重复入库。' +
      '正文至少 300 字符； References 之后的部分会被自动剔除。',
    parameters: ADD_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          paper: { type: 'object', additionalProperties: true },
          created: { type: 'boolean' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          total: { type: 'number' },
          chars: { type: 'number' },
          depth: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      // 会话卡片：≤6 行，不铺长文本（FR-9.8）
      render: (_args, value) => {
        if (!value || value.paper === undefined) {
          return [{ type: 'text', text: '登记失败。' }]
        }
        const rows = Array.isArray(value.hits) ? value.hits : []
        const rawTitle = String(value.paper.title ?? '')
        const title = rawTitle.length > 48 ? rawTitle.slice(0, 47) + '…' : rawTitle
        const warnings = Array.isArray(value.warnings) ? value.warnings : []
        // 告警并进 meta 行，保证总行数 ≤ 6（FR-9.8）
        const meta = [
          `${rows.length} 个算法`,
          `${value.chars ?? '?'} 字符`,
          value.depth === 'abstract' ? '仅摘要' : '全文',
          ...(warnings.length > 0 ? [`⚠ ${warnings.join(' / ')}`] : []),
        ].join(' · ')
        const lines = [`${value.created === true ? '已登记' : '已更新'}《${title}》`, meta]
        if (rows.length === 0) {
          lines.push('没有识别到词典内的算法（正文可能过短，或需要扩充词典）。')
        } else {
          for (const row of rows.slice(0, 3)) lines.push(`  · ${row.name} ×${row.count}`)
          if (rows.length > 3) lines.push(`  · 其余 ${rows.length - 3} 个略`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const store = await getStore()

      // ⓪ PDF：读本地文件 → 子进程抽文本 → 丢弃原件
      const pdfPath = String(args?.pdfPath ?? '').trim()
      if (pdfPath !== '') {
        return ingestPdf(store, pdfPath, args ?? {})
      }

      // ① 快速添加：input 认 DOI / arXiv / 链接
      const input = String(args?.input ?? '').trim()
      if (input !== '') {
        const resolved = await resolveInput(input, args ?? {})
        const registered = await registerCandidate(store, resolved, {
          fields: args?.fields ?? resolved.fields,
          preferFullText: true,
        })
        return boundResult(registered)
      }

      // ② 粘贴正文
      const title = String(args?.title ?? '').trim()
      const text = String(args?.text ?? '')
      if (title === '' || text.trim() === '') {
        throw new RadarError(
          'VALIDATION',
          '要么给 input（DOI / arXiv id / 链接）让插件自己去取，要么同时给 title 与 text 粘贴正文。',
          { field: input === '' ? 'input' : 'text' },
        )
      }
      return ingestPaper(store, args)
    },
  }
}

/** PDF 单文件上限（§7 FR-1.8：≤20MB）。 */
const MAX_PDF_BYTES = 20 * 1024 * 1024

/** 从 PDF 抽出的文本里猜一个标题：取第一行像样的、不太长的句子。 */
function guessTitleFromText(text, fallback) {
  for (const line of String(text).split(/\r?\n/)) {
    const clean = line.replace(/\s+/g, ' ').trim()
    if (clean.length >= 8 && clean.length <= 120) return clean
  }
  return fallback
}

/**
 * 登记一篇 PDF（§7 FR-1.8 / FR-10.8）。
 * 读文件 → 子进程解析（带超时强杀）→ 统计 → **不留存 PDF 原件**。
 */
async function ingestPdf(store, pdfPath, args) {
  let info
  try {
    info = await stat(pdfPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new RadarError('NOT_FOUND', `找不到文件：${pdfPath}`, { field: 'pdfPath' })
    }
    throw new RadarError('VALIDATION', `无法读取文件：${error?.message ?? error}`, { field: 'pdfPath' })
  }
  if (!info.isFile()) {
    throw new RadarError('VALIDATION', `不是文件：${pdfPath}`, { field: 'pdfPath' })
  }
  if (info.size > MAX_PDF_BYTES) {
    throw new RadarError(
      'PAYLOAD_TOO_LARGE',
      `PDF 过大（${(info.size / 1024 / 1024).toFixed(1)}MB，上限 20MB）。请拆分或先转成文本。`,
      { field: 'pdfPath' },
    )
  }

  let parsed
  try {
    parsed = await extractPdfInWorker(pdfPath, { timeoutMs: 20000 })
  } catch (error) {
    const code = error?.code === 'PDF_TIMEOUT' ? 'EXTRACT_FAILED' : 'UNSUPPORTED_MEDIA'
    throw new RadarError(code, `PDF 解析失败：${error?.message ?? error}`, { field: 'pdfPath' })
  }

  const text = String(parsed?.text ?? '').trim()
  if (text === '') {
    // 扫描件 / 纯图 / CID 字体：明确告知，不假装成功
    throw new RadarError(
      'UNSUPPORTED_MEDIA',
      `这个 PDF 里没有可提取的文本（${(parsed?.diagnostics ?? []).join('；') || '多半是扫描件'}）。` +
        '请改用 OCR 后的文本，或直接把正文粘过来。',
      { field: 'pdfPath' },
    )
  }
  // 质量闸门：字形码 / 二进制噪声不能进库。长度够、但没有一个词，就是这种情况。
  const pdfHealth = analyzeText(text)
  if (!pdfHealth.usable) {
    throw new RadarError(
      'UNSUPPORTED_MEDIA',
      `这个 PDF 抽出来的不是自然语言（${pdfHealth.reasons.join('；')}），字体多半是 CID/Type0 子集，本工具解不出字形。` +
        '换条路更省时间：把正文文字复制粘贴进来，或者先用 OCR 转成文本。',
      { field: 'pdfPath' },
    )
  }
  if (text.length < 300) {
    throw new RadarError(
      'EXTRACT_FAILED',
      `PDF 里只抽到 ${text.length} 个字符，不足以统计（多数是纯图页面或字体编码不支持）。`,
      { field: 'pdfPath' },
    )
  }

  const fallbackTitle = pdfPath.split(/[\\/]/).pop().replace(/\.pdf$/i, '')
  const result = await ingestPaper(store, {
    title: String(args?.title ?? '').trim() || guessTitleFromText(text, fallbackTitle),
    text,
    year: args?.year,
    venue: args?.venue,
    doi: args?.doi,
    arxivId: args?.arxivId,
    fields: args?.fields,
    depth: 'fulltext',
    source: 'pdf',
  })

  // 只回报解析诊断，不回显正文；PDF 原件全程没被复制或留存
  return {
    ...result,
    pdf: {
      streams: parsed?.streams ?? 0,
      decoded: parsed?.decoded ?? 0,
      diagnostics: parsed?.diagnostics ?? [],
      discarded: true,
    },
  }
}

/**
 * 把一个 DOI / arXiv id / 链接解析成候选（§7 FR-1.7）。
 * 正文优先级：arXiv HTML 全文 → 摘要（depth 会如实标成 abstract）。
 */
async function resolveInput(input, args) {
  const target = parseInputTarget(input)
  if (target === null) {
    throw new RadarError('VALIDATION', `认不出这个输入：${input}。给 DOI、arXiv id 或它们是链接。`, { field: 'input' })
  }

  if (target.kind === 'arxiv') {
    const meta = await resolveArxiv(target.value)
    return {
      title: meta.title,
      year: args?.year ?? meta.year,
      venue: args?.venue ?? meta.venue,
      doi: args?.doi ?? meta.doi,
      arxivId: target.value,
      url: meta.url,
      abstract: meta.abstract,
      citations: meta.citations,
      fields: args?.fields,
      // 让 registerCandidate 去抓 arXiv HTML 全文
      source: 'arxiv',
    }
  }

  if (target.kind === 'doi') {
    const meta = await resolveDoi(target.value)
    // arXiv 的 DOI（10.48550/arXiv.xxxx）能走全文
    const arxivId = meta.arxivId !== '' ? meta.arxivId : arxivIdOf({ doi: meta.doi })
    return {
      title: meta.title,
      year: args?.year ?? meta.year,
      venue: args?.venue ?? meta.venue,
      doi: meta.doi,
      arxivId,
      url: meta.url,
      abstract: meta.abstract,
      citations: meta.citations,
      fields: args?.fields,
      source: meta.source,
    }
  }

  throw new RadarError(
    'VALIDATION',
    '网页链接暂不支持自动解析；请给 DOI 或 arXiv id（或直接把正文粘过来）。',
    { field: 'input' },
  )
}

const RANKING_PARAMETERS = {
  type: 'object',
  properties: {
    rankBy: {
      type: 'string',
      enum: ['papers', 'mentions'],
      description: '排序口径：papers（论文数，默认，抗长文膨胀）或 mentions（提及数）。',
    },
    type: { type: 'string', description: '只看某一类：DL / ML / MATH，留空表示全部。' },
    q: { type: 'string', description: '按算法名或分类过滤（包含匹配，大小写不敏感）。' },
    limit: { type: 'number', description: '返回条数，默认 20，最大 50。' },
    offset: { type: 'number', description: '从第几条开始，默认 0。' },
  },
  additionalProperties: false,
}

const PAPERS_PARAMETERS = {
  type: 'object',
  properties: {
    q: { type: 'string', description: '按标题 / 会议过滤（包含匹配，大小写不敏感）。' },
    field: { type: 'string', description: '只看某个领域标签。' },
    yearFrom: { type: 'number', description: '起始年份（含）。' },
    yearTo: { type: 'number', description: '结束年份（含）。' },
    depth: { type: 'string', enum: ['fulltext', 'abstract'], description: '只看全文级或仅摘要级。' },
    hasText: { type: 'boolean', description: '只看是否留存正文。W0 恒为 false（正文留存尚未落地）。' },
    limit: { type: 'number', description: '返回条数，默认 20，最大 50。' },
    offset: { type: 'number', description: '从第几条开始，默认 0。' },
  },
  additionalProperties: false,
}

const RANKING_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: true } },
    total: { type: 'number' },
    offset: { type: 'number' },
    limit: { type: 'number' },
    truncated: { type: 'boolean' },
    denominator: { type: 'number' },
    paperCount: { type: 'number' },
    mentionCount: { type: 'number' },
  },
}

/**
 * `radar_ranking` —— 算法排行（§7 FR-3.0 / FR-3.1）。
 * 排序：论文数 desc → 提及数 desc → 规范名 asc（码位序，禁 localeCompare）。
 * 覆盖率 = 论文数 ÷ 当前筛选条件下的论文数（分母随筛选变，§8 R9）。
 */
function buildRankingTool(getStore) {
  return {
    name: 'radar_ranking',
    description:
      '查询「论文算法雷达」的算法排行。默认按「提及该算法的论文数」排序（抗长文膨胀），也可切到提及数。' +
      '返回排名、规范名、类型、分类、论文数、提及数、覆盖率、首见 / 最近年份。支持 type / q 过滤与 limit / offset 分页。',
    parameters: RANKING_PARAMETERS,
    output: {
      schema: RANKING_OUTPUT,
      render: (_args, value) => {
        const rows = Array.isArray(value?.items) ? value.items : []
        if (rows.length === 0) return [{ type: 'text', text: '没有符合条件的算法。' }]
        const lines = rows.map(
          (row) => `${row.rank}. ${row.name} — ${row.papers} 篇 / ${row.mentions} 次（覆盖 ${Math.round((row.coverage ?? 0) * 100)}%）`
        )
        const head = `${value.paperCount ?? 0} 篇论文 · ${value.total ?? rows.length} 个算法`
        const tail = value.truncated === true ? `\n（只显示前 ${rows.length} 个，还有 ${(value.total ?? 0) - rows.length} 个）` : ''
        return [{ type: 'text', text: `${head}\n${lines.join('\n')}${tail}` }]
      },
    },
    async execute(args) {
      const store = await getStore()
      const rankBy = args?.rankBy === 'mentions' ? 'mentions' : 'papers'
      const type = String(args?.type ?? '').toUpperCase().trim()
      const needle = String(args?.q ?? '').trim().toLowerCase()

      const state = buildState(store, { paperLimit: 0 })
      let rows = state.algorithms
      if (type !== '' && type !== 'ALL') rows = rows.filter((item) => item.type === type)
      if (needle !== '') {
        rows = rows.filter(
          (item) =>
            String(item.name).toLowerCase().includes(needle) || String(item.family ?? '').toLowerCase().includes(needle)
        )
      }
      // 分母跟随筛选：只被筛掉的论文不算进来
      const denominator = needle === '' && (type === '' || type === 'ALL')
        ? state.paperCount
        : countPapersMatching(store, rows)

      const sorted = [...rows].sort((x, y) => {
        if (rankBy === 'mentions') {
          if (y.mentions !== x.mentions) return y.mentions - x.mentions
          if (y.papers !== x.papers) return y.papers - x.papers
          return compareCodePoints(x.name, y.name)
        }
        if (y.papers !== x.papers) return y.papers - x.papers
        if (y.mentions !== x.mentions) return y.mentions - x.mentions
        return compareCodePoints(x.name, y.name)
      })

      const page = paginate(sorted, { limit: args?.limit, offset: args?.offset })
      return boundResult({
        items: page.items.map((item, index) => ({
          rank: page.offset + index + 1,
          id: item.id,
          name: item.name,
          type: item.type,
          family: item.family,
          papers: item.papers,
          mentions: item.mentions,
          coverage: denominator > 0 ? Math.round((item.papers / denominator) * 10000) / 10000 : 0,
          firstYear: item.firstYear,
          lastYear: item.lastYear,
        })),
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        truncated: page.truncated,
        denominator,
        paperCount: state.paperCount,
        mentionCount: state.mentionCount,
        dictVersion: dictVersionOf(store),
      })
    },
  }
}

/** 当前筛选命中的论文数（分母）：召回的算法所覆盖的论文集合大小。 */
function countPapersMatching(store, algorithms) {
  const ids = new Set(algorithms.map((item) => item.id))
  const papers = new Set()
  for (const mention of store.mentions.values()) {
    if (ids.has(mention.algorithmId)) papers.add(mention.paperId)
  }
  return papers.size
}

/**
 * `radar_papers` —— 论文列表（§7 S-b / FR-3.8 的 W0 部分）。
 * 不返回正文，只给标题与命中概览。
 */
function buildPapersTool(getStore) {
  return {
    name: 'radar_papers',
    description:
      '列出「论文算法雷达」里的论文（按登记时间倒序）。支持关键词、领域、年份区间、正文深度筛选与分页。' +
      '只返回标题、年份、会议、领域、深度、命中算法数与 Top 算法，**不含正文**。',
    parameters: PAPERS_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          total: { type: 'number' },
          offset: { type: 'number' },
          limit: { type: 'number' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const rows = Array.isArray(value?.items) ? value.items : []
        if (rows.length === 0) return [{ type: 'text', text: '没有符合条件的论文。' }]
        const lines = rows.map(
          (row) => `· ${row.title}（${row.year ?? '—'} · ${row.depth === 'abstract' ? '仅摘要' : '全文'} · ${row.hitCount} 个算法）`
        )
        const tail = value.truncated === true ? `\n（共 ${value.total} 篇，只显示 ${rows.length} 篇）` : ''
        return [{ type: 'text', text: `共 ${value.total} 篇：\n${lines.join('\n')}${tail}` }]
      },
    },
    async execute(args) {
      const store = await getStore()
      // paperLimit 必须给足：buildState 默认只取 60 篇，而列表工具要全量再分页
      const state = buildState(store, { paperLimit: Number.MAX_SAFE_INTEGER })
      const needle = String(args?.q ?? '').trim().toLowerCase()
      const field = String(args?.field ?? '').trim()
      const yearFrom = Number.isFinite(Number(args?.yearFrom)) ? Number(args.yearFrom) : null
      const yearTo = Number.isFinite(Number(args?.yearTo)) ? Number(args.yearTo) : null
      const depth = args?.depth === 'abstract' || args?.depth === 'fulltext' ? args.depth : null
      const hasText = typeof args?.hasText === 'boolean' ? args.hasText : null

      const rows = state.papers
        .filter((paper) => {
          if (needle !== '') {
            const hay = `${paper.title} ${paper.venue ?? ''}`.toLowerCase()
            if (!hay.includes(needle)) return false
          }
          if (field !== '' && !(paper.fields ?? []).includes(field)) return false
          if (yearFrom !== null && (paper.year === null || paper.year < yearFrom)) return false
          if (yearTo !== null && (paper.year === null || paper.year > yearTo)) return false
          if (depth !== null && paper.depth !== depth) return false
          if (hasText !== null && paper.hasText !== hasText) return false
          return true
        })
        .sort((x, y) => (y.readAt ?? 0) - (x.readAt ?? 0) || compareCodePoints(x.title, y.title))

      const page = paginate(rows, { limit: args?.limit, offset: args?.offset })
      return boundResult({
        items: page.items.map((paper) => ({
          id: paper.id,
          title: paper.title,
          year: paper.year,
          venue: paper.venue,
          fields: paper.fields,
          depth: paper.depth,
          hitCount: paper.hitCount,
          hasText: paper.hasText === true,
          topAlgorithms: (paper.top ?? []).slice(0, 3),
        })),
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        truncated: page.truncated,
      })
    },
  }
}

const STATUS_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

/**
 * `radar_status` —— 运行状态（§10.1 GET /overview 的模型侧入口）。
 * 给口径、规模、体积、待重算、已注册工具、迁移报告；**不返回正文**。
 */
function buildStatusTool(getStore) {
  return {
    name: 'radar_status',
    description:
      '查看「论文算法雷达」的运行状态：论文数 / 算法数 / 提及数、词典口径与快照版本、数据文件路径与体积、' +
      '有多少条提及是旧口径、已注册的工具、以及上次快照迁移的报告。不返回正文。',
    parameters: STATUS_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          dictVersion: { type: 'string' },
          schemaVersion: { type: 'number' },
          paperCount: { type: 'number' },
          algorithmCount: { type: 'number' },
          mentionCount: { type: 'number' },
          abstractOnlyCount: { type: 'number' },
          staleMentions: { type: 'number' },
          storeFile: { type: 'string' },
          dbBytes: { type: 'number' },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '状态不可用。' }]
        const kb = value.dbBytes ? Math.round((value.dbBytes / 1024) * 10) / 10 + ' KB' : '—'
        const lines = [
          `${value.paperCount} 篇论文 · ${value.algorithmCount} 个算法 · ${value.mentionCount} 次提及`,
          `口径 ${value.dictVersion} · 快照 v${value.schemaVersion} · 库 ${kb}`,
          value.abstractOnlyCount > 0 ? `其中 ${value.abstractOnlyCount} 篇仅摘要` : null,
          value.staleMentions > 0 ? `⚠ ${value.staleMentions} 条提及是旧口径（可用 radar_reextract 重算，W1.0）` : null,
          `工具：${(value.tools ?? []).join(', ')}`,
        ].filter((line) => line !== null)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const store = await getStore()
      await maybeDailyBackup(store, { schemaVersion: SCHEMA_VERSION, dictVersion: dictVersionOf(store) })
      return boundResult(await statusSnapshot(store))
    },
  }
}

/** 状态快照（工具与 `/radar status` 共用）。 */
async function statusSnapshot(store) {
  const state = buildState(store, { paperLimit: 0 })
  let dbBytes = 0
  try {
    const info = await stat(store.file)
    dbBytes = info.size
  } catch {
    dbBytes = 0
  }
  let staleMentions = 0
  for (const mention of store.mentions.values()) {
    if (mention.dictVersion !== dictVersionOf(store)) staleMentions += 1
  }
  return {
    dictVersion: dictVersionOf(store),
    schemaVersion: SCHEMA_VERSION,
    paperCount: state.paperCount,
    algorithmCount: state.algorithmCount,
    mentionCount: state.mentionCount,
    abstractOnlyCount: state.abstractOnlyCount,
    staleMentions,
    stalePapers: state.stalePapers,
    staleRecomputable: state.staleRecomputable,
    hasTextCount: state.hasTextCount,
    storeFile: store.file,
    dbBytes,
    backup: await backupStatus(store),
    candidates: candidateStats(store),
    guide: { enabled: GUIDE_ENABLED, dismissed: store.meta.get('guide')?.dismissed === true },
    tools: REGISTERED_TOOL_NAMES,
    command: COMMAND_STATE,
    capabilities: { write: WRITE_ENABLED, textRead: TEXT_READ_ENABLED },
    migration: store.migration,
  }
}

const DISCOVER_PARAMETERS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '领域关键词，如「空气质量预测」或 "air quality prediction"。' },
    limit: { type: 'number', description: '候选条数，默认 8，最大 20。' },
  },
  required: ['query'],
  additionalProperties: false,
}

/**
 * `radar_discover` —— 按关键词检索候选，**只列不登记**（§7 FR-6.1）。
 * 已在库内的候选会用 `inLibrary` 标出来（按三键判定），避免重复登记。
 */
const EXPORT_PARAMETERS = {
  type: 'object',
  properties: {
    format: { type: 'string', enum: ['json', 'csv'], description: '导出格式：json（全量）/ csv（排行），默认 json。' },
    includeText: {
      type: 'number',
      enum: [0, 1],
      description: '是否包含论文正文。默认 0；正文留存要到 W1.0 才有，现在传 1 也不会带出内容。',
    },
  },
  additionalProperties: false,
}

/**
 * `radar_export` —— 导出到文件（§7 FR-7.3）。
 * **只落盘并返回路径与体积，内容不进上下文**（§8 R12 / P-6）。
 */
const REEXTRACT_PARAMETERS = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      enum: ['all', 'stale', 'ids'],
      description: '重算范围：all=全部有留存正文的论文；stale=只重算旧口径；ids=按 ids 指定。默认 stale。',
    },
    ids: { type: 'array', items: { type: 'string' }, description: 'scope=ids 时要重算的论文 id。' },
    dryRun: {
      type: 'boolean',
      description: '只预览不写库。**默认 true**；确认无误后必须显式传 false 才会真正重算。',
    },
  },
  additionalProperties: false,
}

/**
 * `radar_reextract` —— 用当前词典对**已留存正文**重新抽取（FR-2.9）。
 * 不联网、不重抓；`dryRun` 默认 true。
 */
function buildReextractTool(getStore) {
  return {
    name: 'radar_reextract',
    description:
      '用当前词典对已留存的正文原地重算，替换该论文的全部提及（不累加）。' +
      '范围可选 all / stale（只重算旧口径）/ ids。**默认 dryRun=true 只给 diff 预览**，确认后传 dryRun=false 才写库。' +
      '不联网、不重抓；没有留存正文的论文会被跳过并计数。',
    parameters: REEXTRACT_PARAMETERS,
    timeoutMs: 300000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          scope: { type: 'string' },
          dryRun: { type: 'boolean' },
          total: { type: 'number' },
          changed: { type: 'number' },
          skippedNoText: { type: 'number' },
          failed: { type: 'number' },
          durationMs: { type: 'number' },
          diff: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '重算失败。' }]
        const head = value.dryRun
          ? `预览（未写库）：${value.total} 篇里 ${value.changed} 篇会变`
          : `已重算：${value.total} 篇里 ${value.changed} 篇有变化`
        const lines = [head]
        for (const item of (value.diff ?? []).filter((d) => d.changed || d.error).slice(0, 4)) {
          if (item.error) {
            lines.push(`  ✗ ${item.title}：${item.error}`)
          } else {
            lines.push(`  · ${item.title}：${item.before} → ${item.after} 个算法`)
          }
        }
        if (value.skippedNoText > 0) lines.push(`  （${value.skippedNoText} 篇没有留存正文，已跳过）`)
        if (value.dryRun) lines.push('确认无误后再次调用并传 dryRun=false。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const store = await getStore()
      return boundResult(await reextractPapers(store, args ?? {}))
    },
  }
}

const IMPORT_PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: '导入文件路径。支持：本插件的全量导出 JSON、精简导出、v0.2 的 store.json。',
    },
    mode: {
      type: 'string',
      enum: ['merge', 'overwrite'],
      description: 'merge（默认）：按三键合并，已存在的论文保留本地 id 并补齐空字段；overwrite：整体替换（危险）。',
    },
    dryRun: {
      type: 'boolean',
      description: '只预览差异不写库。**默认 true**；确认后传 false 才真正导入。',
    },
  },
  required: ['path'],
  additionalProperties: false,
}

/**
 * `radar_import` —— 导入（§7 FR-7.4）。
 * 自动识别三种输入；`dryRun` 默认 true；重复导入靠三键去重，不会变两篇。
 * `mode=overwrite` 且真要写库时，必须先过宿主的写审批（§8 FR-8.5）。
 */
function buildImportTool(getStore, ctx) {
  return {
    name: 'radar_import',
    description:
      '从 JSON 文件导入：本插件的全量导出、精简导出、或 v0.2 的 store.json（自动识别）。' +
      '**默认 dryRun=true 只给差异预览**；确认后传 dryRun=false。合并按三键去重，同一篇不会变两条。' +
      '导入**不带来正文文件**，所以导入后的论文 hasText 保持本地实际状态。',
    parameters: IMPORT_PARAMETERS,
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          kind: { type: 'string' },
          mode: { type: 'string' },
          dryRun: { type: 'boolean' },
          applied: { type: 'boolean' },
          incomingPapers: { type: 'number' },
          incomingMentions: { type: 'number' },
          added: { type: 'number' },
          updated: { type: 'number' },
          replaced: { type: 'number' },
          conflicts: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '导入失败。' }]
        const head = value.applied
          ? `已导入（${value.kind} · ${value.mode}）`
          : `预览（未写库）：${value.kind} · ${value.mode}`
        const lines = [
          head,
          `文件里 ${value.incomingPapers} 篇 / ${value.incomingMentions} 条提及`,
          value.applied
            ? `新增 ${value.added} 篇 · 更新 ${value.updated} 篇${value.replaced > 0 ? ` · 替换 ${value.replaced} 篇` : ''}`
            : `将新增 ${value.added} 篇 · 将更新 ${value.updated} 篇${value.replaced > 0 ? ` · 将替换 ${value.replaced} 篇` : ''}`,
        ]
        if (value.conflicts?.length > 0) lines.push(`  （${value.conflicts.length} 篇命中已有记录，按本地 id 合并）`)
        if (!value.applied) lines.push('确认无误后再次调用并传 dryRun=false。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const store = await getStore()
      const dryRun = args?.dryRun !== false
      // overwrite 会整体替换库内容：只在**真要写库**时要求审批；预览不打扰用户
      if (args?.mode === 'overwrite' && !dryRun) {
        const verdict = await requestWriteApproval(ctx, exec, 'overwrite 导入会整体替换算法库，需要确认。')
        if (verdict !== 'allowed') {
          throw new RadarError('APPROVAL_UNAVAILABLE', describeApprovalVerdict(verdict), { field: 'mode' })
        }
      }
      return importFromPath(store, args)
    },
  }
}

/**
 * 从文件路径导入（工具与路由共用，避免两套实现）。
 */
async function importFromPath(store, args) {
  const path = String(args?.path ?? '').trim()
  if (path === '') throw new RadarError('VALIDATION', '请提供导入文件路径。', { field: 'path' })

  let rawText
  try {
    rawText = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new RadarError('NOT_FOUND', `找不到文件：${path}`, { field: 'path' })
    }
    throw new RadarError('VALIDATION', `读取文件失败：${error?.message ?? error}`, { field: 'path' })
  }
  let raw
  try {
    raw = JSON.parse(rawText)
  } catch (error) {
    throw new RadarError('VALIDATION', `文件不是合法 JSON：${error?.message ?? error}`, { field: 'path' })
  }

  const dryRun = args?.dryRun !== false
  const { report, apply } = planImport(store, raw, { mode: args?.mode, dryRun })
  if (!dryRun) {
    apply(store)
    await store.save()
  }
  return boundResult({ ...report, applied: !dryRun })
}

const ALGORITHM_PARAMETERS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '算法 id（如 transformer）。与 name 二选一。' },
    name: { type: 'string', description: '规范名或别名（如 Transformer / 变换器）。与 id 二选一。' },
    limit: { type: 'number', description: '论文清单条数，默认 20，最大 50。' },
    offset: { type: 'number', description: '从第几条开始，默认 0。' },
  },
  additionalProperties: false,
}

/** 内置词典的索引：快照里还没灌进 algorithms 时兜底用。 */
const LEXICON_BY_ID = new Map(LEXICON.map((entry) => [entry.id, entry]))
const LEXICON_ALIAS = new Map()
for (const entry of LEXICON) {
  LEXICON_ALIAS.set(String(entry.name).toLowerCase(), entry.id)
  for (const alias of entry.aliases ?? []) {
    const key = String(alias).toLowerCase()
    if (!LEXICON_ALIAS.has(key)) LEXICON_ALIAS.set(key, entry.id)
  }
}

/** 按 id 或 name/别名 解析出算法 id；找不到返回空串。 */
function resolveAlgorithmId(store, id, name) {
  const direct = String(id ?? '').trim()
  if (direct !== '' && (store.algorithms.has(direct) || LEXICON_BY_ID.has(direct))) return direct
  const needle = String(name ?? '').trim().toLowerCase()
  if (needle === '') return ''
  for (const [key, entry] of store.algorithms) {
    if (String(entry.name ?? '').toLowerCase() === needle) return key
    if ((entry.aliases ?? []).some((alias) => String(alias).toLowerCase() === needle)) return key
  }
  // 快照没灌词典时的兜底
  return LEXICON_ALIAS.get(needle) ?? ''
}

/**
 * `radar_algorithm` —— 算法详情（§7 FR-3.5）。
 * 给：基本信息、章节分布、年份分布、命中论文清单（含证据片段）。
 */
function buildAlgorithmTool(getStore) {
  return {
    name: 'radar_algorithm',
    description:
      '看某个算法的详情：命中它的论文清单（含证据片段）、章节分布、年份分布与别名。' +
      '用 id 或 name/别名 指定，二选一。证据片段是原文摘录（≤200 字/条），不是整段正文。',
    parameters: ALGORITHM_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          algorithm: { type: 'object', additionalProperties: true },
          papersCount: { type: 'number' },
          mentionCount: { type: 'number' },
          sections: { type: 'object', additionalProperties: true },
          years: { type: 'array', items: { type: 'object', additionalProperties: true } },
          papers: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => {
        if (!value?.algorithm) return [{ type: 'text', text: '没有这个算法。' }]
        const lines = [
          `${value.algorithm.name}（${value.algorithm.type}${value.algorithm.family ? ' · ' + value.algorithm.family : ''}）`,
          `${value.papersCount} 篇论文 · ${value.mentionCount} 次提及`,
        ]
        for (const paper of (value.papers ?? []).slice(0, 5)) {
          lines.push(`  · ${paper.title}（${paper.year ?? '—'}）×${paper.count}`)
        }
        if ((value.papers?.length ?? 0) < value.papersCount) {
          lines.push(`  …还有 ${value.papersCount - (value.papers?.length ?? 0)} 篇`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const store = await getStore()
      const detail = buildAlgorithmDetail(store, args ?? {})
      if (detail === null) {
        throw new RadarError(
          'NOT_FOUND',
          `没有这个算法：${String(args?.name ?? args?.id ?? '').trim() || '（未指定）'}`,
          { field: args?.name !== undefined ? 'name' : 'id' },
        )
      }
      return boundResult(detail)
    },
  }
}

/** 算法详情的纯计算部分（工具与路由共用）。 */
function buildAlgorithmDetail(store, args = {}) {
  const algorithmId = resolveAlgorithmId(store, args.id, args.name)
  if (algorithmId === '') return null
  const record = store.algorithms.get(algorithmId) ?? LEXICON_BY_ID.get(algorithmId)
  if (record === undefined) return null

  const sections = {}
  const yearMap = new Map()
  const rows = []
  for (const mention of store.mentions.values()) {
    if (mention.algorithmId !== algorithmId) continue
    const paper = store.papers.get(mention.paperId)
    if (paper === undefined) continue

    for (const [rawKey, value] of Object.entries(mention.sections ?? {})) {
      const key = rawKey === 'experiments' ? 'experiment' : rawKey
      sections[key] = (sections[key] ?? 0) + (value ?? 0)
    }
    if (typeof paper.year === 'number') {
      yearMap.set(paper.year, (yearMap.get(paper.year) ?? 0) + 1)
    }
    rows.push({
      id: paper.id,
      title: paper.title,
      year: paper.year,
      venue: paper.venue,
      depth: paper.depth,
      count: mention.count ?? 0,
      dictVersion: mention.dictVersion,
      stale: mention.dictVersion !== dictVersionOf(store),
      snippets: Array.isArray(mention.snippets) ? mention.snippets.slice(0, 3) : [],
    })
  }

  rows.sort((a, b) => b.count - a.count || compareCodePoints(a.title, b.title))
  const page = paginate(rows, { limit: args.limit, offset: args.offset })

  const mentionCount = rows.reduce((sum, row) => sum + row.count, 0)
  const years = [...yearMap.entries()]
    .map(([year, papers]) => ({ year, papers }))
    .sort((a, b) => a.year - b.year)

  return {
    algorithm: {
      id: algorithmId,
      name: record.name ?? algorithmId,
      type: record.type ?? 'OTHER',
      typeLabel: TYPE_LABELS[record.type] ?? '其他',
      family: record.family ?? '',
      aliases: Array.isArray(record.aliases) ? record.aliases : [],
    },
    papersCount: rows.length,
    mentionCount,
    firstYear: years.length > 0 ? years[0].year : null,
    lastYear: years.length > 0 ? years[years.length - 1].year : null,
    sections,
    years,
    papers: page.items,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    truncated: page.truncated,
  }
}

/** 清空的确认词（§7 FR-7.5：需输入确认词 + 审批）。 */
const CLEAR_WORDS = new Set(['清空', '全部清空', 'clear', 'CLEAR', 'clear all', 'CLEAR ALL'])

function countMentionsOf(store, paperId) {
  let count = 0
  for (const mention of store.mentions.values()) {
    if (mention.paperId === paperId) count += 1
  }
  return count
}

/**
 * `radar_remove` —— 删一篇（§7 FR-2.10 / FR-8.5 / FR-8.7）。
 * 默认 dryRun；真删要审批；删后 10 秒内可撤销。
 */
function buildRemoveTool(getStore, undoStack, ctx) {
  return {
    name: 'radar_remove',
    description:
      '删除一篇论文（连带它的全部提及与三键）。**默认 dryRun=true 只预览**；真删除需要宿主审批。' +
      '删除后 10 秒内可用 radar_restore 撤销（正文文件在窗口内保留，撤销回来仍可重算）。',
    parameters: {
      type: 'object',
      properties: {
        paperId: { type: 'string', description: '要删除的论文 id。' },
        dryRun: { type: 'boolean', description: '只预览不删。默认 true。' },
      },
      required: ['paperId'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          paperId: { type: 'string' },
          title: { type: 'string' },
          mentions: { type: 'number' },
          dryRun: { type: 'boolean' },
          undo: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '删除失败。' }]
        if (value.dryRun) {
          return [{ type: 'text', text: `预览（未删除）：《${value.title}》与其 ${value.mentions} 条提及。确认后传 dryRun=false。` }]
        }
        return [{ type: 'text', text: `已删除《${value.title}》（${value.mentions} 条提及）。10 秒内可用 radar_restore 撤销。` }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const store = await getStore()
      const paperId = String(args?.paperId ?? '').trim()
      if (paperId === '') throw new RadarError('VALIDATION', '缺少论文 id。', { field: 'paperId' })
      const paper = store.papers.get(paperId)
      if (paper === undefined) throw new RadarError('NOT_FOUND', `没有这篇论文：${paperId}`, { field: 'paperId' })

      const dryRun = args?.dryRun !== false
      const mentions = countMentionsOf(store, paperId)
      if (dryRun) return { paperId, title: paper.title, mentions, dryRun: true }

      const verdict = await requestWriteApproval(ctx, exec, `删除《${paper.title}》会移除它的 ${mentions} 条提及。`)
      if (verdict !== 'allowed') {
        throw new RadarError('APPROVAL_UNAVAILABLE', describeApprovalVerdict(verdict), { field: 'paperId' })
      }

      const result = await removePaper(store, paperId, { keepText: true })
      const undo = undoStack.push('delete', {
        label: `删除《${paper.title}》`,
        dump: result.removed,
        texts: paper.hasText === true ? [paperId] : [],
      })
      return { paperId, title: paper.title, mentions, dryRun: false, removedMentions: result.removedMentions, undo }
    },
  }
}

/** `radar_clear` —— 清空全库（§7 FR-7.5）。需确认词 + 审批；10 秒内可撤销。 */
function buildClearTool(getStore, undoStack, ctx) {
  return {
    name: 'radar_clear',
    description:
      '清空整个算法库（**保留词典**）。默认 dryRun=true 只预览；真清空需要 confirm 传「清空」或「CLEAR」**并**通过宿主审批。' +
      '清空后 10 秒内可用 radar_restore 撤销。建议先 radar_export 备份。',
    parameters: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: '只预览不清空。默认 true。' },
        confirm: { type: 'string', description: '确认词：真清空时必须传「清空」或「CLEAR」。' },
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          papers: { type: 'number' },
          mentions: { type: 'number' },
          dryRun: { type: 'boolean' },
          cleared: { type: 'number' },
          undo: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '清空失败。' }]
        if (value.dryRun) {
          return [{ type: 'text', text: `预览（未清空）：${value.papers} 篇论文 / ${value.mentions} 条提及。建议先 radar_export 备份；确认后传 dryRun=false 且 confirm="清空"。` }]
        }
        return [{ type: 'text', text: `已清空 ${value.cleared} 篇论文（词典保留）。10 秒内可用 radar_restore 撤销。` }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const store = await getStore()
      const dryRun = args?.dryRun !== false
      const papers = store.papers.size
      const mentions = store.mentions.size
      if (dryRun) return { papers, mentions, dryRun: true }

      const word = String(args?.confirm ?? '').trim()
      if (!CLEAR_WORDS.has(word)) {
        throw new RadarError('VALIDATION', '清空需要确认词：confirm 传「清空」或「CLEAR」。', { field: 'confirm' })
      }
      const verdict = await requestWriteApproval(ctx, exec, `清空会移除 ${papers} 篇论文与 ${mentions} 条提及。`)
      if (verdict !== 'allowed') {
        throw new RadarError('APPROVAL_UNAVAILABLE', describeApprovalVerdict(verdict), { field: 'confirm' })
      }

      const { cleared, dump } = await clearLibrary(store)
      const undo = undoStack.push('clear', { label: `清空 ${cleared} 篇论文`, dump, texts: dump.texts })
      return { papers, mentions, dryRun: false, cleared, undo }
    },
  }
}

/** `radar_restore` —— 撤销一次删除/清空（§7 FR-2.10）。 */
function buildRestoreTool(getStore, undoStack) {
  return {
    name: 'radar_restore',
    description: '撤销 10 秒内的删除或清空。令牌来自 radar_remove / radar_clear 的返回。',
    parameters: {
      type: 'object',
      properties: { token: { type: 'string', description: '撤销令牌。' } },
      required: ['token'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          restoredPapers: { type: 'number' },
          kind: { type: 'string' },
          label: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '撤销失败。' }]
        return [{ type: 'text', text: `已撤销：${value.label}（恢复 ${value.restoredPapers} 篇论文）。` }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const token = String(args?.token ?? '').trim()
      if (token === '') throw new RadarError('VALIDATION', '缺少撤销令牌。', { field: 'token' })
      const entry = undoStack.take(token)
      if (entry === null) {
        throw new RadarError('NOT_FOUND', '撤销窗口已过期（10 秒）或令牌无效。', { field: 'token' })
      }
      const store = await getStore()
      restoreDump(store, entry.payload.dump)
      await store.save()
      return {
        restoredPapers: entry.payload.dump.papers?.length ?? 0,
        kind: entry.kind,
        label: entry.payload.label ?? entry.kind,
      }
    },
  }
}

/**
 * 趋势（§7 FR-4.x / §10.1 `radar_trends`）。
 * 缺年份的论文**不计入趋势**，但要如实回报篇数（图例要写「另有 N 篇无年份未计入」）。
 */
function buildTrends(store, args = {}) {
  const includeSamples = args.includeSamples === true
  const sampleOk = (paper) => includeSamples || paper?.isSample !== true
  // FR-4.4 双时间轴：发表年（默认）或入库年
  const axis = args.axis === 'readAt' ? 'readAt' : 'year'
  const yearOfPaper = (paper) => {
    if (paper === undefined) return null
    if (axis === 'readAt') {
      const stamp = Number(paper.readAt ?? 0)
      if (!Number.isFinite(stamp) || stamp <= 0) return null
      return new Date(stamp).getFullYear()
    }
    return typeof paper.year === 'number' ? paper.year : null
  }
  const ids = Array.isArray(args.ids) ? args.ids.map((id) => String(id).trim()).filter(Boolean) : []
  const from = normalizeYear(args.from) ?? null
  const to = normalizeYear(args.to) ?? null

  // 没指定就取论文数最多的前 N 个，避免把上百个算法画成面条
  let targets = ids
  if (targets.length === 0) {
    const counts = new Map()
    for (const mention of store.mentions.values()) {
      if (!sampleOk(store.papers.get(mention.paperId))) continue
      counts.set(mention.algorithmId, (counts.get(mention.algorithmId) ?? 0) + 1)
    }
    targets = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0]))
      .slice(0, clampInt(args.limit ?? 5, 1, 12))
      .map(([id]) => id)
  }

  const yearSet = new Set()
  const undatedIds = new Set()
  for (const mention of store.mentions.values()) {
    if (!targets.includes(mention.algorithmId)) continue
    const paper = store.papers.get(mention.paperId)
    if (paper === undefined || !sampleOk(paper)) continue
    const y = yearOfPaper(paper)
    if (typeof y === 'number') yearSet.add(y)
    else undatedIds.add(paper.id)
  }

  const series = targets.map((id) => {
    const record = store.algorithms.get(id) ?? LEXICON_BY_ID.get(id)
    const perYear = new Map()
    for (const mention of store.mentions.values()) {
      if (mention.algorithmId !== id) continue
      const mentionPaper = store.papers.get(mention.paperId)
      if (!sampleOk(mentionPaper)) continue
      const year = yearOfPaper(mentionPaper)
      if (typeof year !== 'number') continue
      if (from !== null && year < from) continue
      if (to !== null && year > to) continue
      perYear.set(year, (perYear.get(year) ?? 0) + 1)
    }
    return {
      id,
      name: record?.name ?? id,
      type: record?.type ?? 'OTHER',
      points: [...perYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, papers]) => ({ year, papers })),
    }
  })

  const allYears = [...yearSet].sort((a, b) => a - b)
  return {
    series,
    axis,
    from,
    to,
    years: allYears,
    yearMin: allYears.length > 0 ? allYears[0] : null,
    yearMax: allYears.length > 0 ? allYears[allYears.length - 1] : null,
    undatedCount: undatedIds.size,
  }
}

/** 领域分布（§7 FR-5.4 / §10.1 `radar_fields`）。 */
function buildFields(store, options = {}) {
  const includeSamples = options.includeSamples === true
  const counts = new Map()
  let unclassified = 0
  let counted = 0
  for (const paper of store.papers.values()) {
    if (!includeSamples && paper.isSample === true) continue
    counted += 1
    const fields = Array.isArray(paper.fields) ? paper.fields.filter((field) => String(field).trim() !== '') : []
    // 登记时没给领域会被默认成 ['未分类']，所以「未分类」要按这个标签算，而不是按空数组
    const meaningful = fields.filter((field) => field !== '未分类')
    if (meaningful.length === 0) {
      unclassified += 1
      continue
    }
    for (const field of new Set(meaningful)) {
      counts.set(field, (counts.get(field) ?? 0) + 1)
    }
  }
  return {
    fields: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || compareCodePoints(a.name, b.name)),
    unclassified,
    total: counted,
  }
}

const TRENDS_PARAMETERS = {
  type: 'object',
  properties: {
    ids: { type: 'array', items: { type: 'string' }, description: '算法 id 列表；不传则取论文数最多的前 5 个。' },
    from: { type: 'number', description: '起始年份（含）。' },
    to: { type: 'number', description: '结束年份（含）。' },
    limit: { type: 'number', description: '未指定 ids 时取几个，默认 5，最大 12。' },
  },
  additionalProperties: false,
}

function buildTrendsTool(getStore) {
  return {
    name: 'radar_trends',
    description:
      '按年份看若干算法的论文数趋势。不传 ids 就取论文数最多的前 5 个。' +
      '缺年份的论文不计入趋势，但会回报 undatedCount（图例说明用）。',
    parameters: TRENDS_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          series: { type: 'array', items: { type: 'object', additionalProperties: true } },
          undatedCount: { type: 'number' },
        },
      },
      render: (_args, value) => {
        if (!value?.series || value.series.length === 0) {
          return [{ type: 'text', text: '没有可画的趋势（库为空或都没有年份）。' }]
        }
        const lines = value.series.map(
          (s) => `${s.name}: ${s.points.map((p) => `${p.year}×${p.papers}`).join(' ') || '（无年份数据）'}`,
        )
        if (value.undatedCount > 0) lines.push(`另有 ${value.undatedCount} 篇无年份未计入`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const store = await getStore()
      return boundResult(buildTrends(store, args ?? {}))
    },
  }
}

function buildFieldsTool(getStore) {
  return {
    name: 'radar_fields',
    description: '看领域分布：每个领域有多少篇论文，以及没打标签的篇数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          fields: { type: 'array', items: { type: 'object', additionalProperties: true } },
          unclassified: { type: 'number' },
        },
      },
      render: (_args, value) => {
        if (!value || value.fields.length === 0) return [{ type: 'text', text: '还没有领域标签。' }]
        const lines = value.fields.slice(0, 10).map((f) => `${f.name}: ${f.count} 篇`)
        if (value.unclassified > 0) lines.push(`未分类：${value.unclassified} 篇`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const store = await getStore()
      return boundResult(buildFields(store))
    },
  }
}

/**
 * 示例数据操作（§7 FR-11.2）。
 * `load` 可重复执行（按三键去重）；`clear` 只删示例；`promote` 转正式需二次确认。
 */
async function sampleAction(store, action, args = {}) {
  const { SAMPLE_PAPERS } = await import('./samples.js')

  if (action === 'load') {
    let added = 0
    let reused = 0
    for (const paper of SAMPLE_PAPERS) {
      const result = await ingestPaper(store, { ...paper, isSample: true })
      if (result.created) added += 1
      else reused += 1
    }
    return { action, added, reused, total: SAMPLE_PAPERS.length }
  }

  if (action === 'clear') {
    const ids = [...store.papers.values()].filter((paper) => paper.isSample === true).map((paper) => paper.id)
    for (const id of ids) await removePaper(store, id, { keepText: false })
    return { action, cleared: ids.length }
  }

  if (action === 'promote') {
    if (args.confirm !== true) {
      throw new RadarError('VALIDATION', '转正需要二次确认：传 confirm=true。示例数据一旦转正就会计入统计。', {
        field: 'confirm',
      })
    }
    const samples = [...store.papers.values()].filter((paper) => paper.isSample === true)
    for (const paper of samples) {
      store.papers.set(paper.id, { ...paper, isSample: false, updatedAt: Date.now() })
    }
    if (samples.length > 0) await store.save()
    return { action, promoted: samples.length }
  }

  throw new RadarError('VALIDATION', `不认识的示例操作：${action}。可用 load / clear / promote。`, { field: 'action' })
}

function buildSamplesTool(getStore) {
  return {
    name: 'radar_samples',
    description:
      '示例数据包：load 载入 6 篇示例（默认**不计入**排行/统计/趋势/覆盖率），clear 只删示例，' +
      'promote 把示例转成正式数据（需 confirm=true）。可重复 load，不会重复入库。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['load', 'clear', 'promote'], description: '要做的操作。' },
        confirm: { type: 'boolean', description: 'promote 时必须传 true。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          added: { type: 'number' },
          cleared: { type: 'number' },
          promoted: { type: 'number' },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '示例操作失败。' }]
        if (value.action === 'load') {
          return [{ type: 'text', text: `已载入示例：新增 ${value.added} 篇（共 ${value.total} 篇，不计入统计）。` }]
        }
        if (value.action === 'clear') return [{ type: 'text', text: `已清除 ${value.cleared} 篇示例数据。` }]
        return [{ type: 'text', text: `已转正 ${value.promoted} 篇示例，现在会计入统计。` }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const store = await getStore()
      return sampleAction(store, String(args?.action ?? '').trim(), args ?? {})
    },
  }
}

/**
 * 共现分析（§7 FR-3.6）：哪两个算法常在同一篇论文里出现。
 *
 * 口径：
 *  - 只统计**同一篇论文内**同时出现的算法对，`papers` = 共同出现的论文数
 *  - `lift` = 观测共现数 ÷ 独立假设下的期望共现数（>1 表示比随机更常一起出现）
 *  - 支持按领域过滤；示例数据默认不计入
 */
function buildCooccurrence(store, args = {}) {
  const includeSamples = args.includeSamples === true
  const field = String(args.field ?? '').trim()
  const minPapers = clampInt(args.minPapers ?? 2, 1, 100)
  const limit = clampInt(args.limit ?? 20, 1, 100)

  const perPaper = new Map()
  for (const paper of store.papers.values()) {
    if (!includeSamples && paper.isSample === true) continue
    if (field !== '' && !(Array.isArray(paper.fields) ? paper.fields : []).includes(field)) continue
    perPaper.set(paper.id, new Set())
  }
  for (const mention of store.mentions.values()) {
    perPaper.get(mention.paperId)?.add(mention.algorithmId)
  }

  const paperCount = perPaper.size
  const solo = new Map()
  const pairs = new Map()
  for (const set of perPaper.values()) {
    const ids = [...set].sort(compareCodePoints)
    for (const id of ids) solo.set(id, (solo.get(id) ?? 0) + 1)
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = `${ids[i]}|${ids[j]}`
        pairs.set(key, (pairs.get(key) ?? 0) + 1)
      }
    }
  }

  const nameOf = (id) => store.algorithms.get(id)?.name ?? LEXICON_BY_ID.get(id)?.name ?? id
  const rows = []
  for (const [key, coPapers] of pairs.entries()) {
    if (coPapers < minPapers) continue
    const [a, b] = key.split('|')
    const countA = solo.get(a) ?? 0
    const countB = solo.get(b) ?? 0
    const expected = paperCount > 0 ? (countA / paperCount) * (countB / paperCount) * paperCount : 0
    const lift = expected > 0 ? coPapers / expected : 0
    rows.push({
      a: { id: a, name: nameOf(a) },
      b: { id: b, name: nameOf(b) },
      papers: coPapers,
      papersA: countA,
      papersB: countB,
      lift: Math.round(lift * 100) / 100,
    })
  }

  rows.sort((x, y) => y.papers - x.papers || y.lift - x.lift || compareCodePoints(x.a.name, y.a.name))
  return {
    pairs: rows.slice(0, limit),
    paperCount,
    field: field === '' ? null : field,
    minPapers,
    totalPairs: rows.length,
  }
}

const COOCCURRENCE_PARAMETERS = {
  type: 'object',
  properties: {
    field: { type: 'string', description: '只看某个领域内的论文。' },
    minPapers: { type: 'number', description: '至少要共同出现在多少篇论文里，默认 2。' },
    limit: { type: 'number', description: '返回多少对，默认 20，最大 100。' },
  },
  additionalProperties: false,
}

function buildCooccurrenceTool(getStore) {
  return {
    name: 'radar_cooccurrence',
    description:
      '共现分析：哪两个算法常在同一篇论文里一起出现。给每对的论文数、各自出现的论文数与 lift' +
      '（>1 表示比随机更常同现）。可按领域过滤。',
    parameters: COOCCURRENCE_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          pairs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          paperCount: { type: 'number' },
          totalPairs: { type: 'number' },
        },
      },
      render: (_args, value) => {
        if (!value || value.pairs.length === 0) {
          return [{ type: 'text', text: '没有达到门槛的算法组合（同篇共现的样本还不够）。' }]
        }
        const lines = value.pairs.slice(0, 6).map((p) => `${p.a.name} + ${p.b.name}：${p.papers} 篇（lift ${p.lift}）`)
        return [
          {
            type: 'text',
            text: `共现最高的组合（共 ${value.totalPairs} 对 / ${value.paperCount} 篇）：\n${lines.join('\n')}`,
          },
        ]
      },
    },
    async execute(args) {
      const store = await getStore()
      return boundResult(buildCooccurrence(store, args ?? {}))
    },
  }
}

/** 词典列表（工具与路由共用）。 */
function buildDictionaryView(store) {
  const usage = new Map()
  for (const mention of store.mentions.values()) {
    usage.set(mention.algorithmId, (usage.get(mention.algorithmId) ?? 0) + 1)
  }
  const entries = [...store.algorithms.values()].map((entry) => ({
    id: entry.id,
    name: entry.name,
    type: entry.type,
    family: entry.family ?? '',
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    origin: entry.origin ?? 'seed',
    status: entry.status ?? 'approved',
    papers: usage.get(entry.id) ?? 0,
  }))
  entries.sort((a, b) => b.papers - a.papers || compareCodePoints(a.name, b.name))
  return {
    version: dictVersionOf(store),
    count: entries.length,
    customCount: entries.filter((entry) => entry.origin === 'custom').length,
    disabledCount: entries.filter((entry) => entry.status === 'disabled').length,
    entries,
  }
}

const CANDIDATE_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'list', 'approve', 'reject'],
      description: 'add 提交一个词典外的算法名；list 看候选；approve 转成正式词条；reject 忽略。',
    },
    name: { type: 'string', description: 'add：候选名（词典外的算法名）。' },
    aliases: { type: 'array', items: { type: 'string' }, description: 'add/approve：别名。' },
    type: { type: 'string', enum: ['DL', 'ML', 'MATH'], description: 'approve：类型，默认 MATH。' },
    family: { type: 'string', description: 'approve：分类，默认「自定义」。' },
    paperId: { type: 'string', description: 'add：在哪篇论文里看到的。' },
    note: { type: 'string', description: 'add：上下文备注（≤200 字）。' },
    id: { type: 'string', description: 'approve / reject：候选 id 或名字。' },
  },
  required: ['action'],
  additionalProperties: false,
}

function findCandidate(items, idOrName) {
  const needle = String(idOrName ?? '').trim()
  if (needle === '') return null
  const lower = needle.toLowerCase()
  return items.find((item) => item.id === needle || String(item.name).trim().toLowerCase() === lower) ?? null
}

/**
 * `radar_candidates` —— 词典外算法名的候选队列（§7 FR-2.8）。
 * 插件自己不调 LLM：模型看到词典外的方法名时把名字丢进队列，用户复核后转正式。
 */
function buildCandidatesTool(getStore) {
  return {
    name: 'radar_candidates',
    description:
      '处理「词典外算法名」的候选队列：看到词典里没有的算法/模型名时用 add 记下来，别自己改词典；' +
      '用户复核后用 approve 转成正式词条（会推口径版本），或用 reject 忽略。list 查看候选。',
    parameters: CANDIDATE_PARAMETERS,
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          pending: { type: 'number' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '候选操作失败。' }]
        if (value.action === 'list') {
          if (value.items.length === 0) return [{ type: 'text', text: '没有候选。' }]
          const lines = value.items
            .slice(0, 8)
            .map((item) => `${item.name}${item.seen > 1 ? ` ×${item.seen}` : ''}（${item.status}）`)
          return [{ type: 'text', text: `候选 ${value.items.length} 条，待处理 ${value.pending}：\n${lines.join('\n')}` }]
        }
        if (value.action === 'add') {
          return [{ type: 'text', text: `已记录候选「${value.item?.name}」（待处理 ${value.pending} 条）。` }]
        }
        const verb = value.action === 'approve' ? '采纳' : '忽略'
        return [{ type: 'text', text: `已${verb}「${value.item?.name}」，待处理剩 ${value.pending} 条。` }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const store = await getStore()
      const action = String(args?.action ?? '').trim()
      if (action === 'list') {
        const items = listCandidates(store, { limit: 50 })
        return { action, items, pending: items.filter((item) => item.status === 'pending').length }
      }
      if (action === 'add') {
        const result = await addCandidate(store, args ?? {})
        return { action, created: result.created, item: result.item, pending: result.pending }
      }
      if (action === 'reject') {
        const result = await rejectCandidate(store, args?.id ?? args?.name)
        return { action, item: result.item, pending: result.pending }
      }
      if (action === 'approve') {
        const items = listCandidates(store, { limit: 200 })
        const target = findCandidate(items, args?.id ?? args?.name)
        if (target === null) {
          throw new RadarError('NOT_FOUND', `没有这个候选：${String(args?.id ?? args?.name ?? '')}`, { field: 'id' })
        }
        // 候选可能只是「词典里已有、只是名字写法不同」：先查，别造重复词条
        const existing = [...store.algorithms.values()].find(
          (entry) =>
            entry.status !== 'disabled' && String(entry.name).trim().toLowerCase() === target.name.trim().toLowerCase(),
        )
        if (existing !== undefined) {
          const result = await markCandidateApproved(store, target.id, existing.id)
          return {
            action,
            item: result.item,
            entry: existing,
            alreadyInDictionary: true,
            pending: result.pending,
          }
        }
        const added = await addDictEntry(store, {
          name: target.name,
          type: args?.type,
          family: args?.family,
          aliases: args?.aliases ?? target.aliases,
        })
        const result = await markCandidateApproved(store, target.id, added.entry.id)
        return { action, item: result.item, entry: added.entry, version: added.version, pending: result.pending }
      }
      throw new RadarError('VALIDATION', `不认识的操作：${action}。可用 add / list / approve / reject。`, { field: 'action' })
    },
  }
}

const DICTIONARY_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'update', 'remove', 'moveAlias'],
      description:
        'list 查看；add 新增自定义条目；update 改条目；remove 删除；moveAlias 把一个别名从 from 挪到 to（to 留空=只删除）。',
    },
    id: { type: 'string', description: 'add 时可省（会自动生成）；update / remove 必填。' },
    name: { type: 'string', description: '规范名。' },
    type: { type: 'string', enum: ['DL', 'ML', 'MATH'], description: '类型，默认 MATH。' },
    family: { type: 'string', description: '分类，默认「自定义」。' },
    aliases: { type: 'array', items: { type: 'string' }, description: '别名列表。' },
    from: { type: 'string', description: 'moveAlias：来源条目 id。' },
    to: { type: 'string', description: 'moveAlias：目标条目 id（留空表示只删除该别名）。' },
    alias: { type: 'string', description: 'moveAlias：要搬移的别名。' },
  },
  required: ['action'],
  additionalProperties: false,
}

/**
 * `radar_dictionary` —— 词典管理（§7 FR-2.7）。
 * 改词典会让口径版本 +1，旧提及随即变成「旧口径」，可用 `radar_reextract` 重算。
 */
function buildDictionaryTool(getStore, ctx) {
  return {
    name: 'radar_dictionary',
    description:
      '管理算法词典：list / add / update / remove / moveAlias。' +
      '**改词典会让口径版本 +1**，已有提及随即变成「旧口径」，之后可用 radar_reextract 重算。' +
      '删除内置条目是软删除（标记 disabled），不会抹掉历史提及的可解释性。',
    parameters: DICTIONARY_PARAMETERS,
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          version: { type: 'string' },
          count: { type: 'number' },
          entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '词典操作失败。' }]
        if (value.action === 'list') {
          const lines = value.entries
            .slice(0, 10)
            .map((e) => `${e.name}（${e.type}）· ${e.id}${e.origin === 'custom' ? ' · 自定义' : ''}`)
          if (value.entries.length > 10) lines.push(`…共 ${value.count} 条`)
          return [{ type: 'text', text: `词典 ${value.version}（${value.count} 条）：\n${lines.join('\n')}` }]
        }
        const tail = value.version ? `，口径 → ${value.version}` : ''
        return [{ type: 'text', text: `已执行 ${value.action}${tail}。` }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const store = await getStore()
      const action = String(args?.action ?? '').trim()
      if (action === 'list') {
        return { action, ...buildDictionaryView(store) }
      }
      if (action === 'add') {
        const result = await addDictEntry(store, args ?? {})
        return { action, version: result.version, entry: result.entry }
      }
      if (action === 'update') {
        const result = await updateDictEntry(store, args?.id, args ?? {})
        return { action, version: result.version, entry: result.entry }
      }
      // 删除与别名搬移会改变已有统计的可解释性：走审批
      if (action === 'remove' || action === 'moveAlias') {
        const verdict = await requestWriteApproval(
          ctx,
          exec,
          action === 'remove'
            ? `删除词典条目 ${String(args?.id ?? '')}`
            : `把别名 ${String(args?.alias ?? '')} 挪到 ${String(args?.to ?? '（删除）')}`,
        )
        if (verdict !== 'allowed') {
          throw new RadarError('APPROVAL_UNAVAILABLE', describeApprovalVerdict(verdict), { field: 'action' })
        }
        if (action === 'remove') {
          const result = await removeDictEntry(store, args?.id)
          return { action, ...result }
        }
        const result = await moveDictAlias(store, args ?? {})
        return { action, ...result }
      }
      throw new RadarError('VALIDATION', `不认识的操作：${action}。可用 list / add / update / remove / moveAlias。`, {
        field: 'action',
      })
    },
  }
}

/** 单次返回正文的上限（§10.1：≤ 8,000 字符）。 */
const MAX_TEXT_RETURN = 8000

/** 读一篇留存正文（按 code point 切片，避免把 emoji 切坏）。 */
async function readRetainedText(store, paperId, options = {}) {
  const paper = store.papers.get(String(paperId ?? '').trim())
  if (paper === undefined) {
    throw new RadarError('NOT_FOUND', `没有这篇论文：${paperId}`, { field: 'id' })
  }
  const text = await readText(store.file, paper.id)
  if (text === null) {
    throw new RadarError(
      'NOT_FOUND',
      `《${paper.title}》没有留存正文（v0.2 数据不存正文）。重新登记一次即可留存。`,
      { field: 'id' },
    )
  }
  const codePoints = [...text]
  const offset = clampInt(options.offset ?? 0, 0, codePoints.length)
  const limit = clampInt(options.limit ?? MAX_TEXT_RETURN, 1, MAX_TEXT_RETURN)
  const slice = codePoints.slice(offset, offset + limit)
  return {
    id: paper.id,
    title: paper.title,
    text: slice.join(''),
    offset,
    length: slice.length,
    totalLength: codePoints.length,
    truncated: offset + slice.length < codePoints.length,
    textIncluded: true,
  }
}

/**
 * `radar_text` —— **唯一**把正文送进模型上下文的通道（§10.1 / P-6 / E23）。
 * 只在 `textReadEnabled=true` 时注册；单次 ≤ 8,000 字符，带 truncated 标记。
 */
function buildTextTool(getStore) {
  return {
    name: 'radar_text',
    description:
      '读取一篇论文留存的正文（**只有显式开启 textReadEnabled 时才存在**）。' +
      '单次最多 8,000 字符，超出时 truncated=true，可用 offset 继续读。' +
      '这是正文进入上下文的唯一途径，请只在用户明确要求看正文时使用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '论文 id。' },
        offset: { type: 'number', description: '从第几个字符开始（默认 0）。' },
        limit: { type: 'number', description: '本次最多返回多少字符（默认 8000，上限 8000）。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          length: { type: 'number' },
          totalLength: { type: 'number' },
          truncated: { type: 'boolean' },
          textIncluded: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '读取正文失败。' }]
        const head = `${value.title}（${value.length}/${value.totalLength} 字符${value.truncated ? '，已截断' : ''}）`
        return [{ type: 'text', text: `${head}\n\n${value.text}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const store = await getStore()
      return readRetainedText(store, args?.id, args ?? {})
    },
  }
}

function buildExportTool(getStore) {
  return {
    name: 'radar_export',
    description:
      '把算法库导出成文件：json（论文 / 算法 / 提及 / 键 / 口径，可再导入）或 csv（排行，带 BOM 方便 Excel 打开）。' +
      '**只返回文件路径与体积，内容不进上下文**。默认不含正文（includeText=0）。',
    parameters: EXPORT_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          bytes: { type: 'number' },
          papers: { type: 'number' },
          format: { type: 'string' },
          includeText: { type: 'number' },
        },
      },
      render: (_args, value) => {
        if (!value) return [{ type: 'text', text: '导出失败。' }]
        const kb = Math.round((value.bytes / 1024) * 10) / 10
        const lines = [
          `已导出 ${value.format.toUpperCase()}：${kb} KB · ${value.papers} 篇论文`,
          `路径：${value.path}`,
        ]
        if (value.includeText === 1 && value.hasTextIncluded !== true) {
          lines.push('⚠ 正文留存尚未落地（W1.0），本次导出不含正文。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const store = await getStore()
      return exportToFile(store, args)
    },
  }
}

/** 导出到文件（工具与 `/radar export` 共用）。 */
async function exportToFile(store, args = {}) {
  const format = args?.format === 'csv' ? 'csv' : 'json'
  const includeText = Number(args?.includeText) === 1 ? 1 : 0
  const dir = join(dirname(store.file), 'exports')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const file = join(dir, `radar-${stamp}.${format}`)

  let body
  let papers
  let hasTextIncluded = false
  if (format === 'csv') {
    body = rankingCsv(store)
    papers = store.papers.size
  } else {
    const dump = dumpAll(store)
    if (includeText === 1) {
      // 正文本身不进导出体，只给 id 与 hash 的索引；正文文件在 texts/ 下
      const withText = [...store.papers.values()].filter((paper) => paper.hasText === true)
      hasTextIncluded = withText.length > 0
      dump.texts = withText.map((paper) => ({ paperId: paper.id, textHash: paper.textHash }))
    }
    body = JSON.stringify(dump, null, 2)
    papers = dump.papers.length
  }

  await writeFile(file, body, 'utf8')
  return {
    path: file,
    bytes: Buffer.byteLength(body, 'utf8'),
    papers,
    format,
    includeText,
    hasTextIncluded,
  }
}

function buildDiscoverTool(getStore, ctx) {
  return {
    name: 'radar_discover',
    description:
      '按领域关键词检索论文，**只返回候选，不登记**。每个候选带标题、年份、会议、引用数、是否有足够摘要、是否已在库内（inLibrary）。' +
      '要登记请把候选交给 radar_add_batch，或用 radar_add 粘贴正文。',
    parameters: DISCOVER_PARAMETERS,
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          query: { type: 'string' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          total: { type: 'number' },
          via: { type: 'string' },
          sources: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => {
        const rows = Array.isArray(value?.items) ? value.items : []
        if (rows.length === 0) return [{ type: 'text', text: `「${value?.query ?? ''}」没有检索到候选。` }]
        const lines = rows.map(
          (row, index) =>
            `${index + 1}. ${row.title}${row.year ? ` (${row.year})` : ''}${row.inLibrary ? ' · 已在库' : ''}${row.arxivId ? ' · arXiv' : ''}`
        )
        return [{ type: 'text', text: `「${value.query}」候选 ${rows.length} 篇${value.via ? `（来源 ${value.via}）` : ''}：\n${lines.join('\n')}` }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const store = await getStore()
      const limit = clampInt(args?.limit ?? 8, 1, 20)
      const found = await searchPapers(ctx, { query: args?.query, limit })
      const items = found.items.slice(0, limit).map((item) => {
        const doi = normalizeDoi(item.doi)
        const arxivId = normalizeArxivId(arxivIdOf(item))
        const keys = paperKeysOf({ title: item.title, doi, arxivId })
        const inLibrary = keys.some((key) => store.paperKeys.has(key))
        return {
          title: item.title,
          year: item.year,
          venue: item.venue,
          doi,
          arxivId,
          url: item.url,
          citations: item.citations ?? 0,
          hasAbstract: String(item.abstract ?? '').length >= 120,
          inLibrary,
          abstractPreview: String(item.abstract ?? '').slice(0, 200),
          foundIn: item.sources ?? (item.source ? [item.source] : []),
        }
      })
      return boundResult({
        query: found.query,
        items,
        total: items.length,
        via: found.via ?? 'none',
        sources: found.sources ?? [],
      })
    },
  }
}

const ADD_BATCH_PARAMETERS = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'object' },
      description: '候选数组（radar_discover 的 items 直接传回来即可）。每项至少要有 title，可带 doi / arxivId / abstract / text。',
    },
    pdfPaths: {
      type: 'array',
      items: { type: 'string' },
      description: '批量登记本地 PDF（每个 ≤20MB）。与 items 二选一；单条失败不影响其余。',
    },
    fields: { type: 'string', description: '领域标签，逗号分隔。留空时用候选自带的领域。' },
    preferFullText: {
      type: 'boolean',
      description: '是否尝试抓 arXiv 全文（默认 true）；false 则只用摘要。',
    },
  },
  required: [],
  additionalProperties: false,
}

/**
 * `radar_add_batch` —— 批量登记（§7 FR-6.4 / FR-6.5）。
 * 逐条独立：单条失败只影响该条，结果里带 index 与原因。串行执行（并发 ≤2 的上界）。
 */
function buildAddBatchTool(getStore) {
  return {
    name: 'radar_add_batch',
    description:
      '批量登记候选论文。逐条独立处理：**单条失败只影响该条**，结果按 index 回报 ok / paperId / 错误原因。' +
      '优先抓 arXiv HTML 全文，拿不到就用摘要（depth=abstract）。最多一次 10 条。',
    parameters: ADD_BATCH_PARAMETERS,
    timeoutMs: 300000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          completed: { type: 'number' },
          failed: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const rows = Array.isArray(value?.results) ? value.results : []
        if (rows.length === 0) return [{ type: 'text', text: '没有可登记的条目。' }]
        const head = `已处理 ${rows.length} 条：成功 ${value.completed ?? 0}，失败 ${value.failed ?? 0}`
        const lines = rows.slice(0, 6).map((row) =>
          row.ok
            ? `  ✓ ${row.title}：${row.algorithms} 个算法（${row.depth === 'abstract' ? '仅摘要' : '全文'}）`
            : `  ✗ ${row.title}：${row.error}`
        )
        if (rows.length > 6) lines.push(`  · 其余 ${rows.length - 6} 条略`)
        return [{ type: 'text', text: [head, ...lines].join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const store = await getStore()

      // 批量 PDF（FR-1.9）：逐条独立，扫描件/坏文件只影响自己
      const pdfPaths = Array.isArray(args?.pdfPaths) ? args.pdfPaths.map((p) => String(p).trim()).filter(Boolean).slice(0, 10) : []
      if (pdfPaths.length > 0) {
        const pdfResults = []
        for (let index = 0; index < pdfPaths.length; index += 1) {
          try {
            const result = await ingestPdf(store, pdfPaths[index], { fields: args?.fields })
            pdfResults.push({
              index,
              ok: true,
              path: pdfPaths[index],
              title: result.paper.title,
              depth: result.paper.depth,
              algorithms: result.total,
              created: result.created,
            })
          } catch (error) {
            const payload = toErrorPayload(error)
            pdfResults.push({ index, ok: false, path: pdfPaths[index], title: '', error: payload.message, code: payload.code })
          }
        }
        const done = pdfResults.filter((row) => row.ok).length
        return boundResult({
          results: pdfResults,
          completed: done,
          failed: pdfResults.length - done,
          cancelled: false,
          skipped: Math.max(0, (args?.pdfPaths?.length ?? 0) - pdfPaths.length),
        })
      }

      const rawList = Array.isArray(args?.items) ? args.items : []
      const list = rawList.slice(0, 10)
      const fields = args?.fields
      const preferFullText = args?.preferFullText !== false
      const results = []
      for (let index = 0; index < list.length; index += 1) {
        let candidate
        try {
          candidate = normalizeCandidate(list[index])
        } catch (error) {
          results.push({ index, ok: false, title: '', error: String(error instanceof Error ? error.message : error) })
          continue
        }
        if (candidate.title === '') {
          results.push({ index, ok: false, title: '', error: '缺少标题' })
          continue
        }
        try {
          const registered = await registerCandidate(store, candidate, { fields, preferFullText })
          results.push({
            index,
            ok: true,
            title: candidate.title,
            paperId: registered.paper.id,
            depth: registered.paper.depth,
            algorithms: registered.total,
            created: registered.created,
          })
        } catch (error) {
          const payload = toErrorPayload(error)
          results.push({
            index,
            ok: false,
            title: candidate.title,
            error: payload.message,
            code: payload.code,
          })
        }
      }
      const completed = results.filter((row) => row.ok).length
      return boundResult({
        results,
        completed,
        failed: results.length - completed,
        cancelled: list.length < rawList.length,
        skipped: Math.max(0, rawList.length - list.length),
      })
    },
  }
}


/* ------------------------------------------------------------------ *
 * 领域搜索：委托给已安装的论文搜索插件
 * ------------------------------------------------------------------ */

const SEARCH_TOOL = 'paper_search'
const DEFAULT_SOURCES = 'openalex,crossref,arxiv'
let toolCallSeq = 0

function pickField(source, keys) {
  if (source === null || typeof source !== 'object') return undefined
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** 搜索结果可能包在 results / papers / items / data 里，也可能直接是数组。 */
function extractSearchItems(value) {
  if (Array.isArray(value)) return value
  if (value === null || typeof value !== 'object') return []
  for (const key of ['results', 'papers', 'items', 'data', 'hits', 'entries', 'records']) {
    if (Array.isArray(value[key])) return value[key]
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) && nested.length > 0 && nested[0] !== null && typeof nested[0] === 'object') return nested
  }
  return []
}

async function executePluginTool(ctx, toolName, args, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    toolCallSeq += 1
    const result = await ctx.tools.execute({
      callId: `paper-algo-radar-${Date.now()}-${toolCallSeq}`,
      name: toolName,
      arguments: args,
      signal: controller.signal,
    })
    if (result.isError) {
      const message = result.error && result.error.message ? result.error.message : 'unknown error'
      throw new RadarError('UPSTREAM_FAILED', `工具 ${toolName} 执行失败：${message}`)
    }
    if (result.value !== undefined && result.value !== null) return result.value
    const textBlock = Array.isArray(result.content) ? result.content.find((block) => block && block.type === 'text') : undefined
    if (textBlock && typeof textBlock.text === 'string') {
      try {
        return JSON.parse(textBlock.text)
      } catch {
        return textBlock.text
      }
    }
    return result.value
  } finally {
    clearTimeout(timer)
  }
}

function normalizeCandidate(raw) {
  const authors = pickField(raw, ['authors', 'author', 'penulis', 'creators'])
  return {
    title: String(pickField(raw, ['title', 'judul', 'name']) ?? '').trim(),
    year: normalizeYear(pickField(raw, ['year', 'tahun', 'publication_year', 'published_year', 'publishedAt'])),
    venue: String(pickField(raw, ['venue', 'journal', 'container_title', 'publication', 'sumber']) ?? '').trim(),
    doi: normalizeDoi(pickField(raw, ['doi', 'DOI'])),
    url: String(pickField(raw, ['url', 'link', 'landing_page_url', 'oa_url', 'id']) ?? '').trim(),
    abstract: String(pickField(raw, ['abstract', 'abstrak', 'summary', 'description']) ?? '').trim(),
    authors: Array.isArray(authors)
      ? authors.map((item) => String(item)).slice(0, 6)
      : String(authors ?? '').split(/[;,]/).map((item) => item.trim()).filter(Boolean).slice(0, 6),
    citations: Number(pickField(raw, ['citations', 'cited_by_count', 'sitasi', 'citation_count']) ?? 0) || 0,
    source: String(pickField(raw, ['source', 'sumber', 'provider']) ?? '').trim(),
    openAccess: Boolean(pickField(raw, ['open_access', 'is_open_access', 'oa', 'akses_terbuka'])),
  }
}

/** 从 DOI / URL 里认出 arXiv id，用于尝试抓 HTML 全文。 */
function arxivIdOf(candidate) {
  const doi = String(candidate.doi ?? '')
  const fromDoi = /10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5})/i.exec(doi)
  if (fromDoi) return fromDoi[1]
  const fromUrl = /arxiv\.org\/(?:abs|pdf|html)\/([0-9]{4}\.[0-9]{4,5})/i.exec(String(candidate.url ?? ''))
  if (fromUrl) return fromUrl[1]
  return ''
}

/**
 * paper_search 返回的是给人看的文本（不是 JSON），这里按它的固定版式解析：
 *   1. 标题
 *      2024 · 期刊 · 作者
 *      sumber: openalex · akses terbuka · 3 sitasi
 *      doi: ...
 *      abstrak: ...
 */
function parseSearchText(text) {
  const lines = String(text).split(/\r?\n/)
  const items = []
  let current = null

  const push = () => {
    if (current !== null && current.title !== '') items.push(current)
    current = null
  }

  for (const line of lines) {
    const entry = /^\s*(\d+)\.\s+(.+?)\s*$/.exec(line)
    if (entry !== null) {
      push()
      current = {
        title: entry[2],
        year: null,
        venue: '',
        authors: [],
        doi: '',
        url: '',
        abstract: '',
        citations: 0,
        source: '',
        openAccess: false,
      }
      continue
    }
    if (current === null) continue
    const body = line.trim()
    if (body === '') continue

    const keyed = /^(sumber|doi|abstrak|url|sitasi|citations)\s*:\s*(.+)$/i.exec(body)
    if (keyed !== null) {
      const key = keyed[1].toLowerCase()
      const value = keyed[2].trim()
      if (key === 'sumber') {
        const parts = value.split('·').map((part) => part.trim())
        current.source = parts[0] ?? ''
        current.openAccess = parts.some((part) => /akses terbuka|open access/i.test(part))
        for (const part of parts) {
          const citations = /(\d+)\s*sitasi/i.exec(part)
          if (citations !== null) current.citations = Number(citations[1])
        }
      } else if (key === 'doi') {
        current.doi = value
      } else if (key === 'url') {
        current.url = value
      } else if (key === 'abstrak') {
        current.abstract = value
      } else {
        const citations = /(\d+)/.exec(value)
        if (citations !== null) current.citations = Number(citations[1])
      }
      continue
    }

    if (current.venue === '' && current.year === null && body.includes('·')) {
      const parts = body.split('·').map((part) => part.trim())
      const year = /^(\d{4})$/.exec(parts[0] ?? '')
      if (year !== null) {
        current.year = Number(year[1])
        parts.shift()
      } else if (/^\?$/.test(parts[0] ?? '')) {
        parts.shift()
      }
      const venue = parts.shift() ?? ''
      current.venue = /jurnal tidak dilaporkan/i.test(venue) ? '' : venue
      current.authors = (parts.shift() ?? '').split(';').map((item) => item.trim()).filter(Boolean)
      continue
    }

    if (current.abstract !== '') current.abstract += ' ' + body
  }

  push()
  return items
}

/** OpenAlex 的摘要以倒排索引给出，按位置还原成文本。 */
function abstractFromInverted(index) {
  if (index === null || typeof index !== 'object') return ''
  const pairs = []
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue
    for (const position of positions) pairs.push([position, word])
  }
  pairs.sort((a, b) => a[0] - b[0])
  return pairs.map((pair) => pair[1]).join(' ')
}

async function searchPapers(ctx, input) {
  const query = String(input?.query ?? '').trim()
  if (query === '') throw new RadarError('VALIDATION', '请提供领域关键词，例如「空气质量预测」。', { field: 'query' })

  const limit = clampInt(input?.limit ?? 8, 1, 20)
  const wanted = String(input?.sources ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => ['openalex', 'crossref', 'arxiv'].includes(name))

  let items = []
  let via = 'none'
  let rawSample
  let sourceReports = []

  // 1) 宿主装了论文搜索插件就先问它（能拿到它自己的配额与凭据）
  if (input?.fallback !== 'host-off' && ctx.tools.get(SEARCH_TOOL) !== undefined) {
    try {
      const value = await executePluginTool(ctx, SEARCH_TOOL, { query, max_results: limit }, 120000)
      const parsed = typeof value === 'string' ? parseSearchText(value) : extractSearchItems(value).map(normalizeCandidate)
      if (parsed.length > 0) {
        items = parsed
        via = 'paper_search'
        sourceReports = [{ name: 'paper_search', status: 'ok', count: parsed.length }]
      } else {
        rawSample = String(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 1500)
        sourceReports = [{ name: 'paper_search', status: 'failed', count: 0, error: '返回里没有可解析的条目' }]
      }
    } catch (error) {
      sourceReports = [{ name: 'paper_search', status: 'failed', count: 0, error: String(error?.message ?? error) }]
    }
  }

  // 2) 自带多源并发（§7 FR-6.2 / P-7），单源失败不影响其它源
  if (items.length === 0 && input?.fallback !== 'off') {
    const found = await discoverSources(query, { limit, sources: wanted })
    items = found.items
    sourceReports = [...sourceReports, ...found.sources]
    const okNames = found.sources.filter((s) => s.status === 'ok' && s.count > 0).map((s) => s.name)
    via = okNames.length > 0 ? okNames.join('+') : 'none'
  }

  return {
    query,
    limit,
    via,
    sources: sourceReports,
    items: items.slice(0, limit).map((item) => {
      const arxiv = arxivIdOf(item) !== ''
      return Object.assign({}, item, { arxiv, hasText: arxiv || String(item.abstract ?? '').length >= 120 })
    }),
    rawSample: items.length === 0 ? rawSample : undefined,
  }
}

async function registerCandidate(store, candidate, options) {
  const abstract = String(candidate?.abstract ?? '').trim()
  let body = abstract
  let depth = 'abstract'

  if (options?.preferFullText !== false) {
    const fullText = await fetchArxivFullText(arxivIdOf(candidate))
    if (fullText.length > body.length) {
      body = fullText
      depth = 'fulltext'
    }
  }

  if (body.length < 120) {
    throw new RadarError(
      'EXTRACT_FAILED',
      `《${String(candidate?.title ?? '未命名')}》拿不到足够正文（摘要为空或过短，且没有 arXiv HTML 全文），无法统计。`,
    )
  }

  return ingestPaper(store, {
    title: candidate?.title,
    text: body,
    year: candidate?.year,
    venue: candidate?.venue,
    doi: candidate?.doi,
    // 别把 arXiv id 丢在路上：它是三键之一，丢了就没法去重也没法再抓全文
    arxivId: candidate?.arxivId,
    fields: options?.fields,
    depth,
    source: options?.source ?? candidate?.source,
  })
}

async function removePaper(store, paperId, options = {}) {
  const id = String(paperId ?? '').trim()
  if (id === '') throw new RadarError('VALIDATION', '缺少论文 id。', { field: 'paperId' })

  const existing = store.papers.get(id)
  const existed = store.papers.delete(id)
  const prefix = `${id}::`
  let removedMentions = 0
  const removedMentionList = []
  for (const key of [...store.mentions.keys()]) {
    if (key.startsWith(prefix)) {
      removedMentionList.push(store.mentions.get(key))
      store.mentions.delete(key)
      removedMentions += 1
    }
  }
  // 三键倒排也要清，否则删掉的论文还会被去重命中
  let removedKeys = 0
  const removedKeyEntries = []
  for (const [key, owner] of [...store.paperKeys.entries()]) {
    if (owner === id) {
      removedKeyEntries.push([key, owner])
      store.paperKeys.delete(key)
      removedKeys += 1
    }
  }
  // §8 R11.5 默认同事务删正文；撤销窗口内由调用方传 keepText，否则撤销回来也不能重算
  if (options.keepText !== true) await removeText(store.file, id)
  if (existed) await store.save()

  return {
    paperId: id,
    existed,
    removedMentions,
    removedKeys,
    removed: existed
      ? { papers: [existing], mentions: removedMentionList, paperKeys: removedKeyEntries, meta: [], texts: [] }
      : null,
  }
}

/**
 * 清空整个库（§7 FR-7.5）。**保留词典**——它是共享资产，不是用户数据。
 * 返回被清掉的完整快照，调用方塞进撤销栈；正文文件在窗口内不删。
 */
async function clearLibrary(store) {
  const dump = {
    papers: [...store.papers.values()],
    mentions: [...store.mentions.values()],
    paperKeys: [...store.paperKeys.entries()],
    meta: [...store.meta.entries()],
    texts: [...store.papers.values()].filter((paper) => paper.hasText === true).map((paper) => paper.id),
  }
  const cleared = store.papers.size
  store.papers.clear()
  store.mentions.clear()
  store.paperKeys.clear()
  await store.save()
  return { cleared, dump }
}

/** 把一份快照塞回库里（撤销 / 恢复用）。 */
function restoreDump(store, dump) {
  for (const paper of dump.papers ?? []) store.papers.set(paper.id, paper)
  for (const mention of dump.mentions ?? []) {
    store.mentions.set(`${mention.paperId}::${mention.algorithmId}`, mention)
  }
  for (const [key, owner] of dump.paperKeys ?? []) {
    if (!store.paperKeys.has(key)) store.paperKeys.set(key, owner)
  }
  for (const [key, value] of dump.meta ?? []) store.meta.set(key, value)
}

/**
 * 原地重算（§8 R8.2 / FR-2.9）。
 *
 * 只从**留存的正文**重抽，不联网、不重抓。`dryRun` 默认 true：
 * 不传就别想改库——重算会改历史数字，必须人看过 diff。
 *
 * @param {object} store
 * @param {{ scope?: 'all'|'stale'|'ids', ids?: string[], dryRun?: boolean }} options
 */
async function reextractPapers(store, options = {}) {
  const startedAt = Date.now()
  const scope = options.scope === 'all' || options.scope === 'ids' ? options.scope : 'stale'
  const dryRun = options.dryRun !== false

  let targets
  if (scope === 'ids') {
    const ids = Array.isArray(options.ids) ? options.ids.map((id) => String(id ?? '').trim()).filter(Boolean) : []
    targets = ids.map((id) => store.papers.get(id)).filter((paper) => paper !== undefined)
  } else if (scope === 'all') {
    targets = [...store.papers.values()]
  } else {
    const stale = new Set()
    for (const mention of store.mentions.values()) {
      if (mention.dictVersion !== dictVersionOf(store)) stale.add(mention.paperId)
    }
    targets = [...stale].map((id) => store.papers.get(id)).filter((paper) => paper !== undefined)
  }

  const diff = []
  let changed = 0
  let skippedNoText = 0
  let failed = 0
  const now = Date.now()

  for (const paper of targets) {
    const text = await readText(store.file, paper.id)
    if (text === null) {
      skippedNoText += 1
      continue
    }
    let extracted
    try {
      extracted = extract(text, activeMatchers(store), { dictVersion: dictVersionOf(store), depth: paper.depth })
    } catch (error) {
      failed += 1
      diff.push({ paperId: paper.id, title: paper.title, error: String(error?.message ?? error) })
      continue
    }

    const before = new Map()
    const staleVersions = new Set()
    const activeVersion = dictVersionOf(store)
    for (const mention of store.mentions.values()) {
      if (mention.paperId !== paper.id) continue
      before.set(mention.algorithmId, mention.count)
      // 口径版本变化本身也算「变了」，否则重算完 changed=0 会误导人
      if (mention.dictVersion !== activeVersion) staleVersions.add(mention.dictVersion)
    }
    const after = new Map(extracted.hits.map((hit) => [hit.id, hit.count]))

    const added = [...after.keys()].filter((id) => !before.has(id))
    const removed = [...before.keys()].filter((id) => !after.has(id))
    const countChanged = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id))
    const versionRefreshed = staleVersions.size > 0
    const isChanged = added.length + removed.length + countChanged.length > 0 || versionRefreshed
    if (isChanged) changed += 1

    diff.push({
      paperId: paper.id,
      title: paper.title,
      before: before.size,
      after: after.size,
      added,
      removed,
      countChanged,
      versionRefreshed,
      staleVersions: [...staleVersions],
      changed: isChanged,
    })

    if (!dryRun) {
      const prefix = `${paper.id}::`
      for (const key of [...store.mentions.keys()]) {
        if (key.startsWith(prefix)) store.mentions.delete(key)
      }
      for (const hit of extracted.hits) {
        store.mentions.set(`${prefix}${hit.id}`, {
          paperId: paper.id,
          algorithmId: hit.id,
          count: hit.count,
          sections: hit.sections,
          snippets: hit.snippets,
          role: null,
          dictVersion: dictVersionOf(store),
          updatedAt: now,
        })
      }
      const record = store.papers.get(paper.id)
      if (record !== undefined) {
        record.hitCount = extracted.hits.length
        record.chars = extracted.chars
        record.updatedAt = now
      }
    }
  }

  if (!dryRun && changed > 0) await store.save()

  return {
    scope,
    dryRun,
    dictVersion: dictVersionOf(store),
    total: targets.length,
    changed,
    skippedNoText,
    failed,
    durationMs: Date.now() - startedAt,
    diff: diff.slice(0, 20),
  }
}

/* ------------------------------------------------------------------ *
 * 面板 HTTP 接口
 * ------------------------------------------------------------------ */

const ROUTE_BASE = '/paper-algo-radar'

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 16 * 1024 * 1024) {
        reject(new Error('请求体过大（上限 16MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function createHandler(getStore, ctx, deps = {}) {
  const undoStack = deps.undoStack
  return async function handleRoute(req, res) {
    try {
      const store = await getStore()
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname
      // FR-8.6：writeEnabled=false 时写接口一律拒绝（不只是不注册工具）
      if (!WRITE_ENABLED && WRITE_ROUTE_PATHS.has(path) && req.method === 'POST') {
        throw new RadarError('CAPABILITY_OFF', '写能力已关闭（writeEnabled=false），这次请求没有改动任何数据。')
      }
      if (path === `${ROUTE_BASE}/state` && req.method === 'GET') {
        // tools / command 是「注册结果」而不是库内容，跟在状态体后面带出去
        // §7 FR-11.2：示例默认不计入，面板可传 samples=1 临时计入
        const includeSamples = url.searchParams.get('samples') === '1'
        // FR-7.6：每日备份不靠定时器，读状态时顺带检查一次
        await maybeDailyBackup(store, { schemaVersion: SCHEMA_VERSION, dictVersion: dictVersionOf(store) })
        let dbBytes = 0
        try {
          dbBytes = (await stat(store.file)).size
        } catch {
          dbBytes = 0
        }
        sendJson(res, 200, {
          ...buildState(store, { includeSamples }),
          dbBytes,
          command: COMMAND_STATE,
          undo: undoStack.list(),
          backup: await backupStatus(store),
          candidates: candidateStats(store),
          guide: { enabled: GUIDE_ENABLED, dismissed: store.meta.get('guide')?.dismissed === true },
          capabilities: { write: WRITE_ENABLED, textRead: TEXT_READ_ENABLED },
        })
        return
      }
      if (path === `${ROUTE_BASE}/scan` && req.method === 'POST') {
        const body = await readJsonBody(req)
        // 面板/脚本可以直接给 pdfPath；与 radar_add 的 PDF 分支共用同一实现
        const result =
          String(body?.pdfPath ?? '').trim() !== ''
            ? await ingestPdf(store, String(body.pdfPath).trim(), body)
            : await ingestPaper(store, body)
        sendJson(res, 200, { ok: true, result, state: buildState(store) })
        return
      }
      if (path === `${ROUTE_BASE}/search` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const found = await searchPapers(ctx, body)
        sendJson(res, 200, { ok: true, ...found })
        return
      }
      if (path === `${ROUTE_BASE}/register-one` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const candidate = normalizeCandidate(body?.candidate ?? body)
        const result = await registerCandidate(store, candidate, {
          fields: body?.fields,
          preferFullText: body?.preferFullText !== false,
        })
        sendJson(res, 200, { ok: true, result, state: buildState(store) })
        return
      }
      if (path === `${ROUTE_BASE}/remove` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const paperId = String(body?.paperId ?? '').trim()
        const paper = store.papers.get(paperId)
        // 面板点击本身就是人的决定：这里不再要求审批（工具调用那条路才走审批）
        const removed = await removePaper(store, paperId, { keepText: true })
        const undo = removed.existed
          ? undoStack.push('delete', {
              label: `删除《${paper?.title ?? paperId}》`,
              dump: removed.removed,
              texts: paper?.hasText === true ? [paperId] : [],
            })
          : null
        sendJson(res, 200, { ok: true, removed, undo, state: buildState(store) })
        return
      }
      if (path === `${ROUTE_BASE}/clear` && req.method === 'POST') {
        const body = await readJsonBody(req)
        // 面板清空：需要输入确认词（FR-7.5），但不再重复要审批
        if (!CLEAR_WORDS.has(String(body?.confirm ?? '').trim())) {
          throw new RadarError('VALIDATION', '清空需要确认词：confirm 传「清空」或「CLEAR」。', { field: 'confirm' })
        }
        const { cleared, dump } = await clearLibrary(store)
        const undo = undoStack.push('clear', { label: `清空 ${cleared} 篇论文`, dump, texts: dump.texts })
        sendJson(res, 200, { ok: true, cleared, undo, state: buildState(store) })
        return
      }
      if (path === `${ROUTE_BASE}/restore` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const token = String(body?.token ?? '').trim()
        const entry = undoStack.take(token)
        if (entry === null) {
          throw new RadarError('NOT_FOUND', '撤销窗口已过期（10 秒）或令牌无效。', { field: 'token' })
        }
        restoreDump(store, entry.payload.dump)
        await store.save()
        sendJson(res, 200, {
          ok: true,
          restoredPapers: entry.payload.dump.papers?.length ?? 0,
          kind: entry.kind,
          state: buildState(store),
        })
        return
      }
      if (path === `${ROUTE_BASE}/algorithm` && req.method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        const name = url.searchParams.get('name') ?? ''
        const detail = buildAlgorithmDetail(store, { id, name, limit: 50 })
        if (detail === null) {
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个算法' } })
          return
        }
        sendJson(res, 200, detail)
        return
      }
      if (path === `${ROUTE_BASE}/trends` && req.method === 'GET') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const from = url.searchParams.get('from')
        const to = url.searchParams.get('to')
        sendJson(
          res,
          200,
          buildTrends(store, {
            ids,
            from,
            to,
            limit: url.searchParams.get('limit'),
            includeSamples: url.searchParams.get('samples') === '1',
            axis: url.searchParams.get('axis') ?? 'year',
          }),
        )
        return
      }
      if (path === `${ROUTE_BASE}/samples` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const result = await sampleAction(store, String(body?.action ?? '').trim(), body ?? {})
        sendJson(res, 200, { ok: true, result, state: buildState(store) })
        return
      }
      if (path === `${ROUTE_BASE}/locale` && req.method === 'GET') {
        // §7 FR-9.6：locale/*.json 是唯一真源，客户端按宿主语言取
        const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh'
        const localePath = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'locale', `${lang}.json`)
        try {
          const body = await readFile(localePath, 'utf8')
          sendJson(res, 200, JSON.parse(body))
        } catch {
          sendJson(res, 200, {})
        }
        return
      }
      if (path === `${ROUTE_BASE}/guide` && req.method === 'POST') {
        store.meta.set('guide', { key: 'guide', dismissed: true, dismissedAt: Date.now() })
        await store.save()
        sendJson(res, 200, { ok: true, guide: { enabled: GUIDE_ENABLED, dismissed: true } })
        return
      }
      if (path === `${ROUTE_BASE}/candidates` && req.method === 'GET') {
        const items = listCandidates(store, { limit: 100 })
        sendJson(res, 200, { items, stats: candidateStats(store) })
        return
      }
      if (path === `${ROUTE_BASE}/candidates` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const action = String(body?.action ?? '').trim()
        if (action === 'reject') {
          const result = await rejectCandidate(store, body?.id ?? body?.name)
          sendJson(res, 200, { ok: true, ...result, stats: candidateStats(store) })
          return
        }
        if (action === 'approve') {
          const items = listCandidates(store, { limit: 200 })
          const target = findCandidate(items, body?.id ?? body?.name)
          if (target === null) {
            throw new RadarError('NOT_FOUND', `没有这个候选：${String(body?.id ?? body?.name ?? '')}`, { field: 'id' })
          }
          const added = await addDictEntry(store, { name: target.name, aliases: target.aliases })
          const result = await markCandidateApproved(store, target.id, added.entry.id)
          sendJson(res, 200, { ok: true, ...result, entry: added.entry, dictionary: buildDictionaryView(store), stats: candidateStats(store) })
          return
        }
        if (action === 'add') {
          const result = await addCandidate(store, body ?? {})
          sendJson(res, 200, { ok: true, ...result, stats: candidateStats(store) })
          return
        }
        throw new RadarError('VALIDATION', `不认识的操作：${action}`, { field: 'action' })
      }
      if (path === `${ROUTE_BASE}/dictionary` && req.method === 'GET') {
        sendJson(res, 200, buildDictionaryView(store))
        return
      }
      if (path === `${ROUTE_BASE}/dictionary` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const action = String(body?.action ?? '').trim()
        if (action === 'add') {
          const result = await addDictEntry(store, body ?? {})
          sendJson(res, 200, { ok: true, ...result, dictionary: buildDictionaryView(store) })
          return
        }
        if (action === 'update') {
          const result = await updateDictEntry(store, body?.id, body ?? {})
          sendJson(res, 200, { ok: true, ...result, dictionary: buildDictionaryView(store) })
          return
        }
        if (action === 'remove') {
          const result = await removeDictEntry(store, body?.id)
          sendJson(res, 200, { ok: true, ...result, dictionary: buildDictionaryView(store) })
          return
        }
        if (action === 'moveAlias') {
          const result = await moveDictAlias(store, body ?? {})
          sendJson(res, 200, { ok: true, ...result, dictionary: buildDictionaryView(store) })
          return
        }
        throw new RadarError('VALIDATION', `不认识的操作：${action}` , { field: 'action' })
      }
      if (path === `${ROUTE_BASE}/cooccurrence` && req.method === 'GET') {
        sendJson(
          res,
          200,
          buildCooccurrence(store, {
            field: url.searchParams.get('field') ?? '',
            minPapers: url.searchParams.get('minPapers'),
            limit: url.searchParams.get('limit'),
            includeSamples: url.searchParams.get('samples') === '1',
          }),
        )
        return
      }
      if (path === `${ROUTE_BASE}/fields` && req.method === 'GET') {
        sendJson(res, 200, buildFields(store, { includeSamples: url.searchParams.get('samples') === '1' }))
        return
      }
      if (path === `${ROUTE_BASE}/import` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const result = await importFromPath(store, body ?? {})
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (path === `${ROUTE_BASE}/reextract` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const result = await reextractPapers(store, body ?? {})
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (path === `${ROUTE_BASE}/export` && req.method === 'GET') {
        sendJson(res, 200, dumpAll(store))
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知接口' } })
    } catch (error) {
      // §10.3：错误一律 { ok:false, error:{ code, message, field? } }，不回显堆栈与正文
      const { status, payload } = toHttpError(error)
      sendJson(res, status, { ok: false, error: payload })
    }
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/** 注册后回查到的工具名（自检用；`/state` 会带出去）。 */
let REGISTERED_TOOL_NAMES = []

/** `/radar` 命令的注册结果（`/state.command` 会带出去）。 */
let COMMAND_STATE = { registered: false, reason: '尚未加载' }

/** 写能力开关（`/state.capabilities.write` 会带出去）。 */
let WRITE_ENABLED = true

/**
 * 每篇封顶次数（§7 FR-3.7）：单篇里同一算法只按这个上限计入提及数，避免长文支配。
 * 0 = 不封顶（默认，保持与历史数据可比）；正整数才生效。
 */
let CAP_PER_PAPER = 0

/**
 * 正文读取开关（§7 FR-12.2 / P-6 / E23）：默认 false，此时 `radar_text` **完全不注册**。
 * 打开后它是正文进入模型上下文的唯一通道，单次 ≤ 8,000 字符。
 */
let TEXT_READ_ENABLED = false

/**
 * 首次激活引导（§7 FR-11.3）：**在面板里**显示一次性提示，可关。
 * 为什么不是「会话注入」：宿主那条路是 `ctx.systemPrompt.section({name, order, text})`，
 * `order` 取自宿主枚举，且没有真实模型回合就无法验证它真的进了提示词；
 * 与其发一条没验过的注入，不如在可控面上做可验证的等价引导。
 */
let GUIDE_ENABLED = true

/** 会被 writeEnabled 拦下的 HTTP 写接口。 */
const WRITE_ROUTE_PATHS = new Set([
  '/paper-algo-radar/scan',
  '/paper-algo-radar/register-one',
  '/paper-algo-radar/remove',
  '/paper-algo-radar/reextract',
  '/paper-algo-radar/import',
  '/paper-algo-radar/remove',
  '/paper-algo-radar/clear',
  '/paper-algo-radar/restore',
  '/paper-algo-radar/samples',
  '/paper-algo-radar/dictionary',
  '/paper-algo-radar/guide',
])

export async function apply(ctx, config = {}) {
  // FR-8.6 能力开关：writeEnabled=false 时**不注册任何写工具**，HTTP 写接口也拒绝。
  // 配置来自 profile 的 cordis.patch.yml（本插件零依赖，不引 schemastery）。
  const writeEnabled = config?.writeEnabled !== false
  WRITE_ENABLED = writeEnabled
  CAP_PER_PAPER = clampInt(config?.capPerPaper ?? 0, 0, 1000)
  TEXT_READ_ENABLED = config?.textReadEnabled === true
  GUIDE_ENABLED = config?.welcomeGuide !== false

  // FR-10.5 加载期零副作用：不读盘、不写盘、不探测。
  // 存储只在第一次真正被用到（工具调用或面板请求）时打开，且只打开一次。
  let opened = null
  const getStore = async () => {
    if (opened === null) {
      opened = (async () => {
        const store = new Store(resolveStoreFile())
        await store.load()
        await seedAlgorithms(store)
        return store
      })()
      // 打开失败时把缓存清掉，下一次请求可以重试
      opened.catch(() => {
        opened = null
      })
    }
    return opened
  }

  // 只读工具
  ctx.effect(() => ctx.tools.register(buildRankingTool(getStore)))
  ctx.effect(() => ctx.tools.register(buildPapersTool(getStore)))
  ctx.effect(() => ctx.tools.register(buildStatusTool(getStore)))
  ctx.effect(() => ctx.tools.register(buildDiscoverTool(getStore, ctx)))
  ctx.effect(() => ctx.tools.register(buildExportTool(getStore)))
  ctx.effect(() => ctx.tools.register(buildAlgorithmTool(getStore)))
  ctx.effect(() => ctx.tools.register(buildTrendsTool(getStore)))
  ctx.effect(() => ctx.tools.register(buildFieldsTool(getStore)))
  ctx.effect(() => ctx.tools.register(buildCooccurrenceTool(getStore)))

  // 撤销窗口（§7 FR-2.10）：过期时才真正删正文文件，窗口内撤销回来还能重算
  const undoStack = new UndoStack({
    windowMs: config?.undoWindowMs,
    onExpire: async (entry) => {
      try {
        const store = await getStore()
        for (const paperId of entry.payload?.texts ?? []) await removeText(store.file, paperId)
      } catch {
        // 过期清理失败不影响调用方
      }
    },
  })

  // §E23：正文读取工具**默认不注册**，只有显式打开 textReadEnabled 才存在
  if (TEXT_READ_ENABLED) {
    ctx.effect(() => ctx.tools.register(buildTextTool(getStore)))
  }

  // 写工具：受 writeEnabled 控制
  if (writeEnabled) {
    ctx.effect(() => ctx.tools.register(buildAddTool(getStore)))
    ctx.effect(() => ctx.tools.register(buildAddBatchTool(getStore)))
    ctx.effect(() => ctx.tools.register(buildReextractTool(getStore)))
    ctx.effect(() => ctx.tools.register(buildImportTool(getStore, ctx)))
    ctx.effect(() => ctx.tools.register(buildRemoveTool(getStore, undoStack, ctx)))
    ctx.effect(() => ctx.tools.register(buildClearTool(getStore, undoStack, ctx)))
    ctx.effect(() => ctx.tools.register(buildRestoreTool(getStore, undoStack)))
    ctx.effect(() => ctx.tools.register(buildSamplesTool(getStore)))
    ctx.effect(() => ctx.tools.register(buildDictionaryTool(getStore, ctx)))
    ctx.effect(() => ctx.tools.register(buildCandidatesTool(getStore)))
  }

  // 自检：注册完回查一次注册表，缺哪个名字能立刻看见（而不是等模型调用失败）
  // radar_text 不在读写清单里（它只在开关打开时存在），但自检必须能看见它——E23 就靠这个证明注册与否
  const expected = [
    ...READ_TOOL_NAMES,
    ...(writeEnabled ? WRITE_TOOL_NAMES : []),
    ...(TEXT_READ_ENABLED ? ['radar_text'] : []),
  ]
  if (typeof ctx.tools.get === 'function') {
    REGISTERED_TOOL_NAMES = expected.filter((name) => ctx.tools.get(name) !== undefined)
    const missing = expected.filter((name) => !REGISTERED_TOOL_NAMES.includes(name))
    if (missing.length > 0) {
      const warn = ctx?.logger?.warn
      if (typeof warn === 'function') warn.call(ctx.logger, `工具未注册成功：${missing.join(', ')}`)
    }
  }

  // `/radar` 控制面命令（§8.9）：只做 status / reextract / export，查询仍是工具的事
  // 注册结果记在 commandState 里并带进 /state —— 免得「没报错」被当成「注册成功」
  const commandState = { registered: false, reason: 'commands 服务未就绪（inject 未回调）' }
  registerRadarCommand(ctx, {
    status: async () => statusSnapshot(await getStore()),
    reextract: async (options) => reextractPapers(await getStore(), options),
    exportFile: async (options) => exportToFile(await getStore(), options),
    onRegistered: () => {
      commandState.registered = true
      commandState.reason = ''
    },
    onSkipped: (reason) => {
      commandState.registered = false
      commandState.reason = reason
    },
  })
  COMMAND_STATE = commandState

  // exact 路由（与 dsh-market 的注册方式一致）：prefix 路由在本版本上未命中。
  ctx.inject(['webServer'], (webCtx) => {
    const handler = createHandler(getStore, ctx, { undoStack })
    for (const endpoint of ['state', 'algorithm', 'trends', 'fields', 'cooccurrence', 'dictionary', 'candidates', 'guide', 'locale', 'samples', 'scan', 'search', 'register-one', 'remove', 'clear', 'restore', 'reextract', 'import', 'export']) {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/${endpoint}`,
        handler,
      }))
    }
  })
}

/* ------------------------------------------------------------------ *
 * 测试出口（仅供 test/ 下的脚本使用；宿主不消费）
 * ------------------------------------------------------------------ */

export const __test = {
  DICT_VERSION,
  Store,
  resolveStoreFile,
  ingestPaper,
  buildAddTool,
  buildRankingTool,
  buildPapersTool,
  buildStatusTool,
  buildDiscoverTool,
  buildAddBatchTool,
  buildExportTool,
  buildReextractTool,
  buildImportTool,
  buildRemoveTool,
  buildClearTool,
  buildRestoreTool,
  clearLibrary,
  restoreDump,
  UndoStack,
  buildAlgorithmTool,
  buildTrendsTool,
  buildFieldsTool,
  buildTrends,
  buildFields,
  buildCooccurrence,
  buildCooccurrenceTool,
  buildDictionaryTool,
  buildDictionaryView,
  buildCandidatesTool,
  buildTextTool,
  readRetainedText,
  dictVersionOf,
  SEED_DICT_VERSION,
  addDictEntry,
  updateDictEntry,
  removeDictEntry,
  moveDictAlias,
  LEXICON,

  buildSamplesTool,
  sampleAction,
  SAMPLE_PAPERS: undefined,
  buildAlgorithmDetail,
  exportToFile,
  statusSnapshot,
  planImport,
  reextractPapers,
  readText,
  writeText,
  removePaper,
  buildState,
  normalizeTitleKey,
  looksLikeArxiv,
  normalizeArxivId,
  paperKeysOf,
}
