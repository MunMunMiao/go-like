interface Labels {
  readonly guide: string
  readonly reference: string
  readonly gettingStarted: string
  readonly architecture: string
  readonly serviceCall: string
  readonly streaming: string
  readonly configRegistryStore: string
  readonly brokerEvents: string
  readonly healthObservability: string
  readonly packages: string
  readonly verification: string
  readonly outline: string
  readonly appearance: string
  readonly menu: string
  readonly top: string
  readonly language: string
  readonly skip: string
}

type LocaleName =
  | "root"
  | "ar-Arab"
  | "es-Latn"
  | "fr-Latn"
  | "ru-Cyrl"
  | "zh-Hans"
  | "zh-Hant-HK"
  | "zh-Hant-TW"

interface NavigationItem {
  readonly text: string
  readonly link: string
}

interface SidebarGroup {
  readonly text: string
  readonly items: NavigationItem[]
}

interface LocaleTheme {
  readonly nav: NavigationItem[]
  readonly sidebar: Record<string, SidebarGroup[]>
  readonly outline: { readonly label: string; readonly level: [number, number] }
  readonly darkModeSwitchLabel: string
  readonly sidebarMenuLabel: string
  readonly returnToTopLabel: string
  readonly langMenuLabel: string
  readonly skipToContentLabel: string
}

interface SiteLocale {
  readonly label: string
  readonly lang: string
  readonly link: string
  readonly dir?: "ltr" | "rtl"
  readonly themeConfig: LocaleTheme
}

interface SiteConfig {
  readonly title: string
  readonly description: string
  readonly head: [string, Record<string, string>][]
  readonly cleanUrls: boolean
  readonly lastUpdated: boolean
  readonly vite: { readonly cacheDir: string }
  readonly locales: Record<LocaleName, SiteLocale>
  readonly themeConfig: {
    readonly search: {
      readonly provider: "local"
      readonly options: {
        readonly locales: Record<
          LocaleName,
          {
            readonly translations: {
              readonly button: {
                readonly buttonText: string
                readonly buttonAriaLabel: string
              }
            }
          }
        >
      }
    }
    readonly socialLinks: { readonly icon: "github"; readonly link: string }[]
  }
  readonly mpa?: boolean
  readonly ignoreDeadLinks?: boolean
}

/** Creates one locale-aware absolute documentation route. */
function route(prefix: string, path: string): string {
  return `${prefix}/${path}`
}

/** Creates one complete localized default-theme configuration. */
function theme(prefix: string, labels: Labels): LocaleTheme {
  return {
    nav: [
      { text: labels.guide, link: route(prefix, "guide/getting-started") },
      { text: labels.reference, link: route(prefix, "reference/packages") }
    ],
    sidebar: {
      [route(prefix, "guide/")]: [
        {
          text: labels.guide,
          items: [
            { text: labels.gettingStarted, link: route(prefix, "guide/getting-started") },
            { text: labels.architecture, link: route(prefix, "guide/architecture") },
            { text: labels.serviceCall, link: route(prefix, "guide/service-call") },
            { text: labels.streaming, link: route(prefix, "guide/streaming") },
            {
              text: labels.configRegistryStore,
              link: route(prefix, "guide/config-registry-store")
            },
            { text: labels.brokerEvents, link: route(prefix, "guide/broker-events") },
            {
              text: labels.healthObservability,
              link: route(prefix, "guide/health-observability")
            }
          ]
        }
      ],
      [route(prefix, "reference/")]: [
        {
          text: labels.reference,
          items: [
            { text: labels.packages, link: route(prefix, "reference/packages") },
            { text: labels.verification, link: route(prefix, "reference/verification") }
          ]
        }
      ]
    },
    outline: { label: labels.outline, level: [2, 3] },
    darkModeSwitchLabel: labels.appearance,
    sidebarMenuLabel: labels.menu,
    returnToTopLabel: labels.top,
    langMenuLabel: labels.language,
    skipToContentLabel: labels.skip
  }
}

const English: Labels = {
  guide: "Guide",
  reference: "Reference",
  gettingStarted: "Getting started",
  architecture: "Architecture",
  serviceCall: "Service calls",
  streaming: "Streaming",
  configRegistryStore: "Config, registry, and store",
  brokerEvents: "Broker and events",
  healthObservability: "Health and observability",
  packages: "Packages",
  verification: "Verification",
  outline: "On this page",
  appearance: "Appearance",
  menu: "Menu",
  top: "Back to top",
  language: "Change language",
  skip: "Skip to content"
}
const Arabic: Labels = {
  guide: "الدليل",
  reference: "المرجع",
  gettingStarted: "البدء",
  architecture: "البنية",
  serviceCall: "استدعاءات الخدمات",
  streaming: "التدفق",
  configRegistryStore: "الإعدادات والسجل والتخزين",
  brokerEvents: "الوسيط والأحداث",
  healthObservability: "الصحة وقابلية الرصد",
  packages: "الحزم",
  verification: "التحقق",
  outline: "في هذه الصفحة",
  appearance: "المظهر",
  menu: "القائمة",
  top: "العودة إلى الأعلى",
  language: "تغيير اللغة",
  skip: "انتقل إلى المحتوى"
}
const Spanish: Labels = {
  guide: "Guía",
  reference: "Referencia",
  gettingStarted: "Primeros pasos",
  architecture: "Arquitectura",
  serviceCall: "Llamadas de servicio",
  streaming: "Streaming",
  configRegistryStore: "Configuración, registro y almacenamiento",
  brokerEvents: "Broker y eventos",
  healthObservability: "Salud y observabilidad",
  packages: "Paquetes",
  verification: "Verificación",
  outline: "En esta página",
  appearance: "Apariencia",
  menu: "Menú",
  top: "Volver arriba",
  language: "Cambiar idioma",
  skip: "Saltar al contenido"
}
const French: Labels = {
  guide: "Guide",
  reference: "Référence",
  gettingStarted: "Bien démarrer",
  architecture: "Architecture",
  serviceCall: "Appels de service",
  streaming: "Streaming",
  configRegistryStore: "Configuration, registre et stockage",
  brokerEvents: "Broker et événements",
  healthObservability: "Santé et observabilité",
  packages: "Paquets",
  verification: "Vérification",
  outline: "Sur cette page",
  appearance: "Apparence",
  menu: "Menu",
  top: "Retour en haut",
  language: "Changer de langue",
  skip: "Aller au contenu"
}
const Russian: Labels = {
  guide: "Руководство",
  reference: "Справочник",
  gettingStarted: "Начало работы",
  architecture: "Архитектура",
  serviceCall: "Вызовы сервисов",
  streaming: "Потоки",
  configRegistryStore: "Конфигурация, реестр и хранилище",
  brokerEvents: "Брокер и события",
  healthObservability: "Проверки и наблюдаемость",
  packages: "Пакеты",
  verification: "Проверка",
  outline: "На этой странице",
  appearance: "Оформление",
  menu: "Меню",
  top: "Наверх",
  language: "Сменить язык",
  skip: "К содержимому"
}
const SimplifiedChinese: Labels = {
  guide: "指南",
  reference: "参考",
  gettingStarted: "快速开始",
  architecture: "架构",
  serviceCall: "服务调用",
  streaming: "流式传输",
  configRegistryStore: "配置、注册与存储",
  brokerEvents: "消息与事件",
  healthObservability: "健康与可观测性",
  packages: "包参考",
  verification: "验证",
  outline: "本页内容",
  appearance: "外观",
  menu: "菜单",
  top: "回到顶部",
  language: "切换语言",
  skip: "跳到正文"
}
const HongKongChinese: Labels = {
  guide: "指南",
  reference: "參考",
  gettingStarted: "開始使用",
  architecture: "架構",
  serviceCall: "服務呼叫",
  streaming: "串流傳輸",
  configRegistryStore: "設定、註冊與儲存",
  brokerEvents: "訊息與事件",
  healthObservability: "健康檢查與可觀測性",
  packages: "套件參考",
  verification: "驗證",
  outline: "本頁內容",
  appearance: "外觀",
  menu: "選單",
  top: "返到頂部",
  language: "轉換語言",
  skip: "跳到正文"
}
const TaiwanChinese: Labels = {
  guide: "指南",
  reference: "參考",
  gettingStarted: "開始使用",
  architecture: "架構",
  serviceCall: "服務呼叫",
  streaming: "串流處理",
  configRegistryStore: "設定、服務註冊與儲存",
  brokerEvents: "訊息代理與事件",
  healthObservability: "健康檢查與可觀測性",
  packages: "套件參考",
  verification: "驗證",
  outline: "本頁內容",
  appearance: "外觀",
  menu: "選單",
  top: "回到頂端",
  language: "切換語言",
  skip: "跳到主要內容"
}

const config: SiteConfig = {
  title: "LikeGo",
  description: "Go-style microservice building blocks for TypeScript backends",
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }]],
  cleanUrls: true,
  lastUpdated: true,
  vite: { cacheDir: "../.artifacts/vitepress-cache" },
  locales: {
    root: { label: "English", lang: "en-Latn", link: "/", themeConfig: theme("", English) },
    "ar-Arab": {
      label: "العربية",
      lang: "ar-Arab",
      link: "/ar-Arab/",
      dir: "rtl",
      themeConfig: theme("/ar-Arab", Arabic)
    },
    "es-Latn": {
      label: "Español",
      lang: "es-Latn",
      link: "/es-Latn/",
      themeConfig: theme("/es-Latn", Spanish)
    },
    "fr-Latn": {
      label: "Français",
      lang: "fr-Latn",
      link: "/fr-Latn/",
      themeConfig: theme("/fr-Latn", French)
    },
    "ru-Cyrl": {
      label: "Русский",
      lang: "ru-Cyrl",
      link: "/ru-Cyrl/",
      themeConfig: theme("/ru-Cyrl", Russian)
    },
    "zh-Hans": {
      label: "简体中文",
      lang: "zh-Hans",
      link: "/zh-Hans/",
      themeConfig: theme("/zh-Hans", SimplifiedChinese)
    },
    "zh-Hant-HK": {
      label: "繁體中文（香港）",
      lang: "zh-Hant-HK",
      link: "/zh-Hant-HK/",
      themeConfig: theme("/zh-Hant-HK", HongKongChinese)
    },
    "zh-Hant-TW": {
      label: "繁體中文（台灣）",
      lang: "zh-Hant-TW",
      link: "/zh-Hant-TW/",
      themeConfig: theme("/zh-Hant-TW", TaiwanChinese)
    }
  },
  themeConfig: {
    search: {
      provider: "local",
      options: {
        locales: {
          root: { translations: { button: { buttonText: "Search", buttonAriaLabel: "Search" } } },
          "ar-Arab": { translations: { button: { buttonText: "بحث", buttonAriaLabel: "بحث" } } },
          "es-Latn": {
            translations: { button: { buttonText: "Buscar", buttonAriaLabel: "Buscar" } }
          },
          "fr-Latn": {
            translations: { button: { buttonText: "Rechercher", buttonAriaLabel: "Rechercher" } }
          },
          "ru-Cyrl": {
            translations: { button: { buttonText: "Поиск", buttonAriaLabel: "Поиск" } }
          },
          "zh-Hans": { translations: { button: { buttonText: "搜索", buttonAriaLabel: "搜索" } } },
          "zh-Hant-HK": {
            translations: { button: { buttonText: "搜尋", buttonAriaLabel: "搜尋" } }
          },
          "zh-Hant-TW": {
            translations: { button: { buttonText: "搜尋", buttonAriaLabel: "搜尋" } }
          }
        }
      }
    },
    socialLinks: [{ icon: "github", link: "https://github.com/MunMunMiao/likego" }]
  }
}

export default config
