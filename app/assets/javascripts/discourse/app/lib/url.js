import { isEmpty } from "@ember/utils";
import EmberObject from "@ember/object";
import { next, schedule } from "@ember/runloop";
import offsetCalculator from "discourse/lib/offset-calculator";
import LockOn from "discourse/lib/lock-on";
import { defaultHomepage } from "discourse/lib/utilities";
import User from "discourse/models/user";
import { default as getURL, withoutPrefix } from "discourse-common/lib/get-url";
import Session from "discourse/models/session";

const rewrites = [];
const TOPIC_REGEXP = /\/t\/([^\/]+)\/(\d+)\/?(\d+)?/;

function redirectTo(url) {
  document.location = url;
  return true;
}

// We can add links here that have server side responses but not client side.
const SERVER_SIDE_ONLY = [
  /^\/assets\//,
  /^\/uploads\//,
  /^\/stylesheets\//,
  /^\/site_customizations\//,
  /^\/raw\//,
  /^\/posts\/\d+\/raw/,
  /^\/raw\/\d+/,
  /^\/wizard/,
  /\.rss$/,
  /\.json$/,
  /^\/admin\/upgrade$/,
  /^\/logs($|\/)/,
  /^\/admin\/logs\/watched_words\/action\/[^\/]+\/download$/,
  /^\/pub\//,
  /^\/invites\//
];

export function rewritePath(path) {
  const params = path.split("?");

  let result = params[0];
  rewrites.forEach(rw => {
    if ((rw.opts.exceptions || []).some(ex => path.indexOf(ex) === 0)) {
      return;
    }
    result = result.replace(rw.regexp, rw.replacement);
  });

  if (params.length > 1) {
    result += `?${params[1]}`;
  }

  return result;
}

export function clearRewrites() {
  rewrites.length = 0;
}

export function userPath(subPath) {
  return getURL(subPath ? `/u/${subPath}` : "/u");
}

export function groupPath(subPath) {
  return getURL(subPath ? `/g/${subPath}` : "/g");
}

let _jumpScheduled = false;
let _transitioning = false;
let lockon = null;

export function jumpToElement(elementId) {
  if (_jumpScheduled || isEmpty(elementId)) {
    return;
  }

  const selector = `#main #${elementId}, a[name=${elementId}]`;
  _jumpScheduled = true;

  schedule("afterRender", function() {
    if (lockon) {
      lockon.clearLock();
    }

    lockon = new LockOn(selector, {
      finished() {
        _jumpScheduled = false;
        lockon = null;
      }
    });
    lockon.lock();
  });
}

const DiscourseURL = EmberObject.extend({
  isJumpScheduled() {
    return _transitioning || _jumpScheduled;
  },

  // Jumps to a particular post in the stream
  jumpToPost(postNumber, opts) {
    opts = opts || {};
    const holderId = `#post_${postNumber}`;

    _transitioning = postNumber > 1;

    schedule("afterRender", () => {
      if (opts.jumpEnd) {
        let $holder = $(holderId);
        let holderHeight = $holder.height();
        let windowHeight = $(window).height() - offsetCalculator();

        // scroll to the bottom of the post and if the post is yuge we go back up the
        // timeline by a small % of the post height so we can see the bottom of the text.
        //
        // otherwise just jump to the top of the post using the lock & holder method.
        if (holderHeight > windowHeight) {
          $(window).scrollTop(
            $holder.offset().top + (holderHeight - holderHeight / 10)
          );
          _transitioning = false;
          return;
        }
      }

      if (postNumber === 1 && !opts.anchor) {
        $(window).scrollTop(0);
        _transitioning = false;
        return;
      }

      let selector;
      let holder;

      if (opts.anchor) {
        selector = `#main #${opts.anchor}, a[name=${opts.anchor}]`;
        holder = document.querySelector(selector);
      }

      if (!holder) {
        selector = holderId;
        holder = document.querySelector(selector);
      }

      if (lockon) {
        lockon.clearLock();
      }

      lockon = new LockOn(selector, {
        finished() {
          _transitioning = false;
          lockon = null;
        }
      });

      if (holder && opts.skipIfOnScreen) {
        const elementTop = lockon.elementTop();
        const scrollTop = $(window).scrollTop();
        const windowHeight = $(window).height() - offsetCalculator();
        const height = $(holder).height();

        if (
          elementTop > scrollTop &&
          elementTop + height < scrollTop + windowHeight
        ) {
          _transitioning = false;
          return;
        }
      }

      lockon.lock();
      if (lockon.elementTop() < 1) {
        _transitioning = false;
        return;
      }
    });
  },

  // Browser aware replaceState. Will only be invoked if the browser supports it.
  replaceState(path) {
    if (
      window.history &&
      window.history.pushState &&
      window.history.replaceState &&
      window.location.pathname !== path
    ) {
      // Always use replaceState in the next runloop to prevent weird routes changing
      // while URLs are loading. For example, while a topic loads it sets `currentPost`
      // which triggers a replaceState even though the topic hasn't fully loaded yet!
      next(() => {
        const location = DiscourseURL.get("router.location");
        if (location && location.replaceURL) {
          location.replaceURL(path);
        }
      });
    }
  },

  routeToTag(a) {
    // skip when we are provided nowhere to route to
    if (!a || !a.href) {
      return false;
    }

    if (a.host && a.host !== document.location.host) {
      document.location = a.href;
      return false;
    }

    return this.routeTo(a.href);
  },

  /**
    Our custom routeTo method is used to intelligently overwrite default routing
    behavior.

    It contains the logic necessary to route within a topic using replaceState to
    keep the history intact.
  **/
  routeTo(path, opts) {
    opts = opts || {};

    if (isEmpty(path)) {
      return;
    }

    if (Session.currentProp("requiresRefresh")) {
      return redirectTo(getURL(path));
    }

    const pathname = path.replace(/(https?\:)?\/\/[^\/]+/, "");

    if (!DiscourseURL.isInternal(path)) {
      return redirectTo(path);
    }

    const serverSide = SERVER_SIDE_ONLY.some(r => {
      if (pathname.match(r)) {
        return redirectTo(path);
      }
    });

    if (serverSide) {
      return;
    }

    // Scroll to the same page, different anchor
    const m = /^#(.+)$/.exec(path);
    if (m) {
      jumpToElement(m[1]);
      return this.replaceState(path);
    }

    const oldPath = window.location.pathname;
    path = path.replace(/(https?\:)?\/\/[^\/]+/, "");

    // Rewrite /my/* urls
    let myPath = getURL("/my");
    const fullPath = getURL(path);
    if (fullPath.indexOf(myPath) === 0) {
      const currentUser = User.current();
      if (currentUser) {
        path = fullPath.replace(
          myPath,
          userPath(currentUser.get("username_lower"))
        );
      } else {
        return redirectTo("/login-preferences");
      }
    }

    // handle prefixes
    if (path.indexOf("/") === 0) {
      path = withoutPrefix(path);
    }

    path = rewritePath(path);

    if (typeof opts.afterRouteComplete === "function") {
      schedule("afterRender", opts.afterRouteComplete);
    }

    if (this.navigatedToPost(oldPath, path, opts)) {
      return;
    }

    if (oldPath === path) {
      // If navigating to the same path send an app event.
      // Views can watch it and tell their controllers to refresh
      this.appEvents.trigger("url:refresh");
    }

    // TODO: Extract into rules we can inject into the URL handler
    if (this.navigatedToHome(oldPath, path, opts)) {
      return;
    }

    // Navigating to empty string is the same as root
    if (path === "") {
      path = "/";
    }

    return this.handleURL(path, opts);
  },

  routeToUrl(url, opts = {}) {
    this.routeTo(getURL(url), opts);
  },

  rewrite(regexp, replacement, opts) {
    rewrites.push({ regexp, replacement, opts: opts || {} });
  },

  redirectTo(url) {
    window.location = getURL(url);
  },

  /**
   * Determines whether a URL is internal or not
   *
   * @method isInternal
   * @param {String} url
   **/
  isInternal(url) {
    if (url && url.length) {
      if (url.indexOf("//") === 0) {
        url = "http:" + url;
      }
      if (url.indexOf("#") === 0) {
        return true;
      }
      if (url.indexOf("/") === 0) {
        return true;
      }
      if (url.indexOf(this.origin()) === 0) {
        return true;
      }
      if (url.replace(/^http/, "https").indexOf(this.origin()) === 0) {
        return true;
      }
      if (url.replace(/^https/, "http").indexOf(this.origin()) === 0) {
        return true;
      }
    }
    return false;
  },

  /**
    If the URL is in the topic form, /t/something/:topic_id/:post_number
    then we want to apply some special logic. If the post_number changes within the
    same topic, use replaceState and instruct our controller to load more posts.
  **/
  navigatedToPost(oldPath, path, routeOpts) {
    const newMatches = TOPIC_REGEXP.exec(path);
    const newTopicId = newMatches ? newMatches[2] : null;

    if (newTopicId) {
      const oldMatches = TOPIC_REGEXP.exec(oldPath);
      const oldTopicId = oldMatches ? oldMatches[2] : null;

      // If the topic_id is the same
      if (oldTopicId === newTopicId) {
        DiscourseURL.replaceState(path);

        const container = Discourse.__container__;
        const topicController = container.lookup("controller:topic");
        const opts = {};
        const postStream = topicController.get("model.postStream");

        if (newMatches[3]) {
          opts.nearPost = newMatches[3];
        }
        if (path.match(/last$/)) {
          opts.nearPost = topicController.get("model.highest_post_number");
        }

        opts.cancelSummary = true;

        postStream.refresh(opts).then(() => {
          const closest = postStream.closestPostNumberFor(opts.nearPost || 1);
          topicController.setProperties({
            "model.currentPost": closest,
            enteredAt: Date.now().toString()
          });

          this.appEvents.trigger("post:highlight", closest);
          const jumpOpts = {
            skipIfOnScreen: routeOpts.skipIfOnScreen,
            jumpEnd: routeOpts.jumpEnd
          };

          const anchorMatch = /#(.+)$/.exec(path);
          if (anchorMatch) {
            jumpOpts.anchor = anchorMatch[1];
          }

          this.jumpToPost(closest, jumpOpts);
        });

        // Abort routing, we have replaced our state.
        return true;
      }
    }

    return false;
  },

  /**
    @private

    Handle the custom case of routing to the root path from itself.

    @param {String} oldPath the previous path we were on
    @param {String} path the path we're navigating to
  **/
  navigatedToHome(oldPath, path) {
    const homepage = defaultHomepage();

    if (
      window.history &&
      window.history.pushState &&
      (path === "/" || path === "/" + homepage) &&
      (oldPath === "/" || oldPath === "/" + homepage)
    ) {
      this.appEvents.trigger("url:refresh");
      return true;
    }

    return false;
  },

  // This has been extracted so it can be tested.
  origin() {
    let prefix = getURL("/");
    return window.location.origin + (prefix === "/" ? "" : prefix);
  },

  // TODO: These container calls can be replaced eventually if we migrate this to a service
  // object.

  /**
    @private

    Get a handle on the application's router. Note that currently it uses `__container__` which is not
    advised but there is no other way to access the router.

    @property router
  **/
  get router() {
    return Discourse.__container__.lookup("router:main");
  },

  get appEvents() {
    return Discourse.__container__.lookup("service:app-events");
  },

  // Get a controller. Note that currently it uses `__container__` which is not
  // advised but there is no other way to access the router.
  controllerFor(name) {
    return Discourse.__container__.lookup("controller:" + name);
  },

  /**
    Be wary of looking up the router. In this case, we have links in our
    HTML, say form compiled markdown posts, that need to be routed.
  **/
  handleURL(path, opts) {
    opts = opts || {};

    const router = this.router;

    if (opts.replaceURL) {
      this.replaceState(path);
    }

    const split = path.split("#");
    let elementId;

    if (split.length === 2) {
      path = split[0];
      elementId = split[1];
    }

    // The default path has a hack to allow `/` to default to defaultHomepage
    // via BareRouter.handleUrl
    let transition;
    if (path === "/" || path.substring(0, 2) === "/?") {
      router._routerMicrolib.updateURL(path);
      transition = router.handleURL(path);
    } else {
      transition = router.transitionTo(path);
    }

    transition._discourse_intercepted = true;
    transition._discourse_anchor = elementId;

    const promise = transition.promise || transition;
    promise.then(() => jumpToElement(elementId));
  }
}).create();

export default DiscourseURL;
