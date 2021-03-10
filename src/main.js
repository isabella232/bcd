import Vue from 'vue'
import Clipboard from 'v-clipboard'
import App from './App.vue'

import './styles';

import store from '@/store'
import router from '@/router'
import VueAnalytics from 'vue-analytics'

import * as Sentry from "@sentry/browser";
import { Vue as VueIntegration } from "@sentry/integrations";

import { shortcut, formatDatetime, formatDate, plural, urlExtractBase58, checkAddress, round } from "@/utils/tz.js";
import { getJwt, logout, getBool } from "@/utils/auth.js";
import { BetterCallApi, UnauthorizedError } from "@/api/bcd.js"
import { NodeRPC } from "@/api/rpc.js"
import { BcdWs } from "@/api/ws.js";

import { makeVuetify } from '@/plugins/vuetify';

import dayjs from 'dayjs';
import updateLocale from 'dayjs/plugin/updateLocale';
import utc from 'dayjs/plugin/utc';


import VJsf from '@baking-bad/vjsf/lib/VJsf.js';
import '@baking-bad/vjsf/lib/VJsf.css';

import draggable from 'vuedraggable';
Vue.component('draggable', draggable);
Vue.component('VJsf', VJsf)

Vue.config.productionTip = false;

dayjs.extend(updateLocale);
dayjs.extend(utc);

dayjs.updateLocale('en', {
  relativeTime: {
    future: "Time Error!",
    past: "%s ago",
    s: 'a few seconds ago',
    m: "a minute ago",
    mm: "%d mins ago",
    h: function(dd, timestamp) {
      if (timestamp) {
        return `1 hour ${dd % 60} mins ago`;
      }
      return `an hour`;
    },
    hh: function(dd, timestamp) {
      if (timestamp) {
        const minutesDiff = dayjs().diff(dayjs(timestamp), "minute") % 60;
        return `${dd} hrs ${minutesDiff} mins ago`;
      }
      return `${dd} hours`;
    },
    d: function(dd, timestamp) {
      if (timestamp) {
        const minutesDiff = dayjs().diff(dayjs(timestamp), "minute") % 60;
        if (dd === 24) {
          return `1 day ${minutesDiff} mins ago`;
        } else if (dd > 24) {
          return `1 day ${dd - 24} hrs ${minutesDiff} mins ago`;
        }
        return `${dd} hrs ${minutesDiff} mins ago`;
      }
      return `${dd} hours`;
    },
    dd: function(d, timestamp) {
      if (timestamp) {
        const minutesDiff = dayjs().diff(dayjs(timestamp), "minute") % 60;
        if (d === 24) {
          return `1 day ${minutesDiff} mins ago`;
        } else if (d > 24) {
          return `1 day ${d - 24} hrs ${minutesDiff} mins ago`;
        }
        return `${d} hrs ${minutesDiff} mins ago`;
      }
      return `${d} hours`;
    },
    M: "a month",
    MM: "%d months",
    y: "a year",
    yy: "%d years"
  }
});

Vue.use(Clipboard)

Vue.filter('formatDate', function (value) {
  if (value) {
    return dayjs(value).format('D MMMM YYYY');
  }
})

Vue.filter('formatTime', function (value) {
  if (value) {
    return dayjs(value).format('D MMMM YYYY HH:mm');
  }
})


Vue.filter('formatShortTime', function (value) {
  if (value) {
    return dayjs(value).format('D MMM YYYY HH:mm');
  }
})

Vue.filter('fromNow', function (value) {
  if (value) {
    return dayjs(value).fromNow();
  }
})

Vue.filter('uxtz', function (value) {
  let xtz = (value / 1000000).toLocaleString(undefined, { maximumFractionDigits: 6 });
  return `${xtz} \uA729`;
})

Vue.filter('mutez', function (value) {
  let xtz = (value / 1000000).toLocaleString(undefined, { maximumFractionDigits: 6 });
  return `${xtz}`;
})

Vue.filter('bytes', function (value) {
  return `${value} bytes`;
})

const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
let config = {
  API_URI: process.env.VUE_APP_API_URI || `${window.location.protocol}//${window.location.host}/v1`,
  WS_URI: process.env.VUE_APP_WS_URI || `${wsProtocol}//${window.location.host}/v1/ws`,
  HOME_PAGE: 'home'
}

let api = new BetterCallApi(config.API_URI);

api.getConfig().then(response => {
  Object.assign(config, response);

  if (config.sandbox_mode) {
    config.HOME_PAGE = 'dashboard';
  }

  let rpc = new NodeRPC(config.rpc_endpoints);
  let ws = new BcdWs(config.WS_URI);

  let helpers = { shortcut, formatDatetime, formatDate, plural, checkAddress, round }

  Vue.mixin({
    data() {
      return { config, api, rpc, ws, helpers }
    }
  });

  if (config.sentry_dsn !== "") {
    Sentry.init({
      dsn: config.sentry_dsn,
      integrations: [new VueIntegration({
        Vue,
        attachProps: true,
        tracing: true,
        tracingOptions: {
          trackComponents: true,
        },
      })],
    });
  }

  router.addRoutes([
    {
      path: '/@:slug([a-zA-Z0-9_.:-]*)',
      name: 'slug',
      beforeEnter: async function (to, from, next) {
        return await api.getContractBySlug(to.params.slug)
          .then(res => next(`/${res.network}/${res.address}`))
          .catch(() => next(`/search?text=${to.params.slug}`))
      }
    },
    {
      path: '*',
      redirect: to => {
        const text = urlExtractBase58(to.path) || to.path.split('/').join(' ');
        return { name: 'search', query: { text } };
      }
    }
  ]);

  router.beforeEach((to, from, next) => {
    const privatePages = ['/dashboard', '/dashboard/'];
    const authRequired = privatePages.includes(to.path);
    const loggedIn = config.sandbox_mode || getJwt() !== null;

    store.dispatch('setIsAuthorized', loggedIn)
    if (authRequired && !loggedIn) {
      return next('/');
    }

    if (loggedIn && store.state.profile === null) {
      api.getProfile()
        .then(res => {
          let subs = res.subscriptions;
          delete res['subscriptions'];
          store.dispatch('setProfile', res);
          store.dispatch('setSubscriptions', subs);
        })
        .catch(err => {
          if (err instanceof UnauthorizedError) {
            store.dispatch('setIsAuthorized', false);
            store.dispatch('setProfile', null);
            store.dispatch('showError', 'Unauthorized access. Please sign in');
          } else {
            store.dispatch('showError', err);
          }
          logout();
          // eslint-disable-next-line
          console.log(err)
        });
    }

    next();
  })

  if (config.GA_ENABLED || config.ga_enabled) {
    Vue.use(VueAnalytics, {
      id: "UA-160856677-1",
      router,
      autoTracking: {
        pageviewTemplate(route) {
          return {
            page: route.name,
            title: document.title,
            location: window.location.href
          }
        }
      },
      debug: {
        enabled: false,
        sendHitTask: true
      }
    });
  }

  const isDark = getBool('dark', true);
  if (isDark) {
    document.body.classList.add('dark-theme-background');
  }

  let vuetify = makeVuetify(isDark);

  new Vue({
    router,
    store,
    vuetify,
    render: h => h(App),
  }).$mount('#app');
});
