"""Evidence-backed directory rules, not examples or installation detection.

Only filesystem metadata is consulted, including OMP's migration-presence check.
An upstream rule cannot reveal another process's CLI flags or environment.
"""
from pathlib import Path
import re

CODEX = 'https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/utils/home-dir/src/lib.rs'
CLAUDE = 'https://github.com/anthropics/claude-agent-sdk-python/blob/dd27b703647a4f8989ab656f00c85f98090a60fd/src/claude_agent_sdk/_internal/sessions.py'
PI = 'https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts'
OMP = 'https://github.com/can1357/oh-my-pi/blob/d5cd750e41fede277f9eb933455da92a0738915e/packages/utils/src/dirs.ts'
OPENCODE = 'https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/util/src/global-roots.ts'

RULES = {
    'codex': {'root':'~/.codex','logs':('sessions','archived_sessions'),'evidence':CODEX,
              'note':'按 Codex 上游规则推导。实际会话位于 sessions 和 archived_sessions；不是配置文件本身。'},
    'claude': {'root':'~/.claude','logs':('projects',),'evidence':CLAUDE,
               'note':'官方 Agent SDK 从 projects/<项目目录> 下读取会话 JSONL。'},
    'pi': {'root':'~/.pi/agent','logs':('sessions',),'evidence':PI,
           'note':'会话位于 agent 目录中的 sessions/<编码后的工作目录>；CLI 指定的其他位置需手动设置。'},
    'omp': {'root':'~/.omp/agent','logs':('sessions',),'evidence':OMP,
            'note':'默认 profile 的传统位置为 ~/.omp/agent/sessions；命名 profile、agentDir 和已迁移 XDG 位置分别解析。'},
    'opencode': {'root':'~/.local/share/opencode','logs':(),'evidence':OPENCODE,
                 'note':'这是数据目录，不是配置目录。稳定渠道通常使用 opencode.db；数据库文件名可随渠道或 OPENCODE_DB 改变。'},
    'antigravity': {'root':None,'logs':(),'evidence':None,
                    'note':'尚无已验证的 Antigravity IDE 会话位置规则，留空；不把其他产品或 CLI 的配置路径当作会话目录。'},
}


def expand(raw, home):
    if raw == '~':
        return home
    if raw.startswith(('~/','~\\')):
        return home/raw[2:]
    return Path(raw)


def result(agent, root=None, source='default', note=None):
    rule = RULES[agent]
    return {'path':root, 'source':source, 'note':note or rule['note'],
            'evidence_url':rule['evidence'], 'logs':rule['logs']}


def profile_name(value):
    name = value.strip() if value is not None else ''
    if not name or name == 'default':
        return None
    if (not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,63}',name) or name.endswith('.')
        or re.match(r'^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)',name,re.I)):
        raise ValueError('invalid profile')
    return name


def omp_location(home, env, platform):
    """Follow the pinned DirResolver's data category, never mutate/migrate it."""
    try:
        profile = profile_name(env.get('OMP_PROFILE',env.get('PI_PROFILE')))
        config_name = env.get('PI_CONFIG_DIR') or '.omp'
        # Upstream describes this as home-relative. Avoid guessing how an
        # out-of-contract value or traversal was resolved by another process.
        if Path(config_name).is_absolute() or '..' in Path(config_name).parts or '~' in config_name:
            return result('omp',source='unresolved',note='PI_CONFIG_DIR 不是明确的主目录相对位置，请手动指定 Oh-My-Pi 的会话数据目录。')
        base = home/config_name
        profile_root = base/'profiles'/profile if profile else base
        agent = profile_root/'agent'
        override = env.get('PI_CODING_AGENT_DIR')
        # A named profile ignores the default-mode agent-dir override. An
        # explicit OMP_PROFILE=default must not inherit a legacy profile dir.
        if not profile and override:
            try:
                legacy = profile_name(env.get('PI_PROFILE'))
            except ValueError:
                legacy = None
            inherited = str(base/'profiles'/legacy/'agent') if legacy else None
            if override != inherited:
                if not Path(override).is_absolute():
                    return result('omp',source='unresolved',note='PI_CODING_AGENT_DIR 为相对路径，无法知道 Oh-My-Pi 的启动工作目录；请手动指定。')
                agent = Path(override)
        default_agent = profile_root/'agent'
        if platform in ('linux','darwin') and agent == default_agent and env.get('XDG_DATA_HOME'):
            xdg = Path(env['XDG_DATA_HOME'])
            if not xdg.is_absolute():
                return result('omp',source='unresolved',note='XDG_DATA_HOME 不是绝对路径，无法可靠推导已迁移数据的位置。')
            target = xdg/'omp'/'profiles'/profile if profile else xdg/'omp'
            # Upstream requires the app/profile path to already exist. A mere
            # XDG variable must not silently move the expected session data.
            if target.exists():
                return result('omp',str(target),'environment','按 Oh-My-Pi 上游迁移规则：对应的 XDG 应用/profile 目录已存在，会话位于其 sessions 子目录。')
        if profile or env.get('PI_CONFIG_DIR') or agent != home/'.omp'/'agent':
            return result('omp',str(agent),'environment','按 Oh-My-Pi 的 profile、配置根目录和 agentDir 优先级推导；会话在该目录的 sessions 中。')
        return result('omp',RULES['omp']['root'])
    except (ValueError,OSError):
        return result('omp',source='unresolved',note='当前 profile 或目录状态无法可靠解析，请手动指定实际会话数据目录。')


def locate(agent, home, env, platform):
    if agent == 'omp':
        return omp_location(home,env,platform)
    rule = RULES[agent]
    if agent == 'opencode':
        base = env.get('XDG_DATA_HOME') or '~/.local/share'
        root = expand(base,home)/'opencode'
        if not root.is_absolute():
            return result(agent,source='unresolved',note='XDG_DATA_HOME 为相对路径，无法推导其他进程实际使用的数据目录。')
        if 'OPENCODE_DB' in env:
            db = env['OPENCODE_DB']
            if not db or db == ':memory:':
                return result(agent,source='unresolved',note='OPENCODE_DB 未指定持久化会话文件，不能预填一个假定的会话数据库目录。')
            db_path = Path(db) if Path(db).is_absolute() else root/db
            return result(agent,str(db_path.parent),'environment','按 OPENCODE_DB 推导数据库所在目录；实际数据库文件名由该环境变量指定。')
        return result(agent,str(root) if env.get('XDG_DATA_HOME') else rule['root'],
                      'environment' if env.get('XDG_DATA_HOME') else 'default')
    if agent == 'pi' and env.get('PI_CODING_AGENT_SESSION_DIR'):
        return result(agent,source='unresolved',note='检测到 PI_CODING_AGENT_SESSION_DIR 指定独立会话目录，不再采用默认 agent/sessions。当前字段用于工具数据根目录，本版不猜测如何反推根目录，请手动设置。')
    key = {'codex':'CODEX_HOME','claude':'CLAUDE_CONFIG_DIR','pi':'PI_CODING_AGENT_DIR'}.get(agent)
    if key and env.get(key):
        raw = env[key]
        # Pi explicitly expands '~'; Codex and the SDK use literal paths.
        path = expand(raw,home) if agent == 'pi' else Path(raw)
        if not path.is_absolute():
            return result(agent,source='unresolved',note=f'{key} 不是可确定的绝对目录，无法推导其他进程的启动路径，请手动指定。')
        return result(agent,str(path),'environment',rule['note']+f' 当前采用 {key}。')
    return result(agent,rule['root'],'default' if rule['root'] is not None else 'unresolved')
