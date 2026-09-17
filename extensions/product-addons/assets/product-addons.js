/**
 * Product add-ons — storefront behaviour.
 *
 * Three jobs:
 *
 *   1. Fetch this product's add-on groups from the app proxy and render them.
 *   2. Carry the customer's choices into the cart — personalization fields as
 *      line item properties on the main item, paid add-ons as their own cart
 *      lines priced by their own variant.
 *   3. Clean up: when the main item leaves the cart, its add-ons go with it.
 *
 * Everything is built with DOM APIs rather than innerHTML. Add-on titles and
 * descriptions are merchant input arriving over the network, and dropping them
 * into innerHTML would make this block a script injection point on every
 * product page that uses it.
 */
(function () {
  "use strict";

  /**
   * Properties whose name starts with an underscore are hidden from the
   * customer in the cart, at checkout and on the order — Shopify's own
   * convention. These two are bookkeeping, not something a shopper should read.
   */
  var PARENT_TOKEN_PROPERTY = "_addon_group";
  var CHILD_TOKEN_PROPERTY = "_addon_for";

  /** Shopify truncates a line item property value at 255 characters. */
  var PROPERTY_MAX_LENGTH = 255;

  var initialised = new WeakSet();

  ready(function () {
    document.querySelectorAll("[data-product-addons]").forEach(init);
    reconcileCart();
  });

  // The theme editor tears a section down and rebuilds it on every settings
  // change, which leaves the old block's listeners bound to a detached form.
  document.addEventListener("shopify:section:load", function (event) {
    var scope = event.target || document;
    scope.querySelectorAll("[data-product-addons]").forEach(init);
  });

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  function routeRoot() {
    var root =
      window.Shopify && window.Shopify.routes && window.Shopify.routes.root;
    return root || "/";
  }

  // ---------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------

  function init(root) {
    if (initialised.has(root)) return;
    initialised.add(root);

    var productId = root.dataset.productId;
    if (!productId) return;

    var url =
      root.dataset.proxy +
      "/config.json?product=" +
      encodeURIComponent(productId) +
      "&collections=" +
      encodeURIComponent(root.dataset.collections || "");

    fetch(url, { headers: { Accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (config) {
        if (!config || !config.groups || config.groups.length === 0) return;
        render(root, config);
      })
      .catch(function (error) {
        // A product page must not break because the add-on service is down.
        // Leaving the block empty degrades to the product's normal behaviour.
        if (window.console && console.warn) {
          console.warn("[product-addons] could not load add-ons:", error);
        }
      });
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function render(root, config) {
    var showHeading = root.dataset.showHeading !== "false";
    var showPrices = root.dataset.showPrices !== "false";
    var money = moneyFormatter(root, config.currency);

    var state = {
      root: root,
      money: money,
      t: translations(root),
      showPrices: showPrices,
      /** id -> { option, input } for every paid add-on rendered. */
      options: Object.create(null),
      /** Rendered personalization fields, in order. */
      fields: [],
      totalEl: null,
    };

    var fragment = document.createDocumentFragment();

    config.groups.forEach(function (group) {
      var section = el("div", "product-addons__group");

      if (showHeading && group.heading) {
        var heading = el("h3", "product-addons__heading");
        heading.classList.add(
          "product-addons__heading--" + (root.dataset.headingSize || "medium"),
        );
        heading.textContent = group.heading;
        section.appendChild(heading);
      }

      if (group.options.length > 0) {
        section.appendChild(renderOptions(state, group));
      }
      group.fields.forEach(function (field) {
        section.appendChild(renderField(state, group, field));
      });

      fragment.appendChild(section);
    });

    if (showPrices) {
      state.totalEl = el("p", "product-addons__total");
      state.totalEl.hidden = true;
      fragment.appendChild(state.totalEl);
    }

    root.appendChild(fragment);
    root.classList.add("product-addons--ready");

    bindToForm(state);
    updateTotal(state);
  }

  function renderOptions(state, group) {
    var single = group.selection === "SINGLE";
    var fieldset = el("fieldset", "product-addons__options");
    var name = "product-addons-" + group.id;

    // A radio group with no way back is a trap: once a customer picks an
    // add-on they can never get to "no add-on" again without reloading.
    if (single) {
      fieldset.appendChild(
        buildOptionRow(state, {
          id: "__none__:" + group.id,
          title: state.t.noThanks,
          description: null,
          priceCents: 0,
          variantId: null,
        }, name, true, true),
      );
    }

    group.options.forEach(function (option) {
      fieldset.appendChild(
        buildOptionRow(state, option, name, single, false),
      );
    });

    return fieldset;
  }

  function buildOptionRow(state, option, name, single, isNone) {
    var row = el("label", "product-addons__option");

    var input = document.createElement("input");
    input.type = single ? "radio" : "checkbox";
    input.className = "product-addons__option-input";
    if (single) input.name = name;
    input.value = option.id;
    if (isNone) input.defaultChecked = true;
    input.addEventListener("change", function () {
      updateTotal(state);
    });

    var body = el("span", "product-addons__option-body");
    var title = el("span", "product-addons__option-title");
    title.textContent = option.title;
    body.appendChild(title);

    if (option.description) {
      var description = el("span", "product-addons__option-description");
      description.textContent = option.description;
      body.appendChild(description);
    }

    row.appendChild(input);
    row.appendChild(body);

    if (state.showPrices && !isNone) {
      var price = el("span", "product-addons__option-price");
      price.textContent = "+" + state.money(option.priceCents);
      row.appendChild(price);
    }

    if (!isNone) {
      state.options[option.id] = { option: option, input: input };
    }

    return row;
  }

  function renderField(state, group, field) {
    var wrapper = el("div", "product-addons__field");
    var id = "product-addons-field-" + field.id;

    var label = el("label", "product-addons__label");
    label.setAttribute("for", id);
    label.textContent = field.label;
    if (field.required) {
      var marker = el("span", "product-addons__required");
      marker.textContent = " *";
      marker.setAttribute("aria-label", state.t.required);
      label.appendChild(marker);
    }

    var control = buildControl(state, field, id);
    var error = el("small", "product-addons__error");
    error.hidden = true;
    error.id = id + "-error";
    control.setAttribute("aria-describedby", error.id);

    // A checkbox reads better with the label beside the box than above it.
    if (field.type === "CHECKBOX") {
      var inline = el("div", "product-addons__field-inline");
      inline.appendChild(control);
      inline.appendChild(label);
      wrapper.appendChild(inline);
    } else {
      wrapper.appendChild(label);
      wrapper.appendChild(control);
    }

    if (field.helpText) {
      var help = el("small", "product-addons__help");
      help.textContent = field.helpText;
      wrapper.appendChild(help);
    }
    wrapper.appendChild(error);

    var entry = { field: field, control: control, error: error };
    control.addEventListener("input", function () {
      clearError(entry);
      updateTotal(state);
    });
    control.addEventListener("change", function () {
      clearError(entry);
      updateTotal(state);
    });

    state.fields.push(entry);
    return wrapper;
  }

  function buildControl(state, field, id) {
    var control;

    if (field.type === "TEXTAREA") {
      control = document.createElement("textarea");
      control.rows = 3;
    } else if (field.type === "SELECT") {
      control = document.createElement("select");
      var blank = document.createElement("option");
      blank.value = "";
      blank.textContent = field.placeholder || state.t.choose;
      control.appendChild(blank);
      (field.choices || []).forEach(function (choice) {
        var opt = document.createElement("option");
        opt.value = choice;
        opt.textContent = choice;
        control.appendChild(opt);
      });
    } else {
      control = document.createElement("input");
      control.type =
        field.type === "CHECKBOX"
          ? "checkbox"
          : field.type === "DATE"
            ? "date"
            : field.type === "NUMBER"
              ? "number"
              : "text";
    }

    control.id = id;
    control.className = "product-addons__control";

    if (field.placeholder && field.type !== "SELECT" && "placeholder" in control) {
      control.placeholder = field.placeholder;
    }
    if (field.type === "TEXT" || field.type === "TEXTAREA") {
      // Capped in the browser as well as in the admin: a value Shopify would
      // truncate is better refused here, where the customer can see why.
      control.maxLength = Math.min(
        field.maxLength || PROPERTY_MAX_LENGTH,
        PROPERTY_MAX_LENGTH,
      );
    }
    if (field.required) {
      // aria-required rather than `required`: the control lives outside the
      // form element on some themes, where native validation would never fire,
      // and a half-working required attribute is worse than none. Validation
      // happens in validate() below.
      control.setAttribute("aria-required", "true");
    }

    return control;
  }

  // ---------------------------------------------------------------------
  // Reading the customer's choices
  // ---------------------------------------------------------------------

  function selectedOptions(state) {
    return Object.keys(state.options)
      .map(function (id) {
        return state.options[id];
      })
      .filter(function (entry) {
        return entry.input.checked;
      })
      .map(function (entry) {
        return entry.option;
      });
  }

  function fieldValue(entry) {
    var control = entry.control;
    if (entry.field.type === "CHECKBOX") {
      return control.checked ? "Yes" : "";
    }
    return (control.value || "").trim();
  }

  /** Line item properties for the main product, from the filled-in fields. */
  function fieldProperties(state) {
    var properties = {};
    state.fields.forEach(function (entry) {
      var value = fieldValue(entry);
      // Empty optional fields are left out entirely rather than sent as blank
      // properties, which would show as noise on the order.
      if (value !== "") properties[entry.field.label] = value;
    });
    return properties;
  }

  function validate(state) {
    var firstInvalid = null;

    state.fields.forEach(function (entry) {
      clearError(entry);
      if (!entry.field.required) return;
      if (fieldValue(entry) !== "") return;

      entry.error.textContent =
        entry.field.type === "CHECKBOX" ? state.t.tick : state.t.fillIn;
      entry.error.hidden = false;
      entry.control.setAttribute("aria-invalid", "true");
      if (!firstInvalid) firstInvalid = entry.control;
    });

    if (firstInvalid) {
      firstInvalid.focus();
      firstInvalid.scrollIntoView({ block: "center", behavior: "smooth" });
      return false;
    }
    return true;
  }

  function clearError(entry) {
    entry.error.hidden = true;
    entry.control.removeAttribute("aria-invalid");
  }

  function updateTotal(state) {
    if (!state.totalEl) return;
    var cents = selectedOptions(state).reduce(function (sum, option) {
      return sum + option.priceCents;
    }, 0);

    if (cents === 0) {
      state.totalEl.hidden = true;
      return;
    }
    state.totalEl.hidden = false;
    state.totalEl.textContent = state.t.total + " +" + state.money(cents);
  }

  // ---------------------------------------------------------------------
  // Cart
  // ---------------------------------------------------------------------

  function bindToForm(state) {
    var form =
      state.root.closest('form[action*="/cart/add"]') ||
      document.querySelector('form[action*="/cart/add"]');
    if (!form) return;

    state.form = form;

    // Personalization fields are mirrored into the form as hidden inputs so
    // that when no paid add-on is selected the theme's own add-to-cart carries
    // them, untouched — no interception, no broken cart drawer.
    var mirror = el("div", "product-addons__mirror");
    mirror.hidden = true;
    form.appendChild(mirror);
    state.mirror = mirror;
    syncMirror(state);
    state.fields.forEach(function (entry) {
      entry.control.addEventListener("input", function () {
        syncMirror(state);
      });
      entry.control.addEventListener("change", function () {
        syncMirror(state);
      });
    });

    // Capture phase, because most themes bind their own submit handler and
    // would otherwise run first.
    form.addEventListener("submit", function (event) {
      if (!validate(state)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      var chosen = selectedOptions(state);
      if (chosen.length === 0) {
        // Nothing to add beyond the product itself. Let the theme handle it.
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      addWithAddons(state, chosen);
    }, true);
  }

  /** Rebuilds the hidden `properties[...]` inputs the theme will submit. */
  function syncMirror(state) {
    if (!state.mirror) return;
    state.mirror.textContent = "";
    var properties = fieldProperties(state);
    Object.keys(properties).forEach(function (label) {
      var input = document.createElement("input");
      input.type = "hidden";
      input.name = "properties[" + label + "]";
      input.value = properties[label];
      state.mirror.appendChild(input);
    });
  }

  function addWithAddons(state, chosen) {
    var form = state.form;
    var data = new FormData(form);

    var variantId = data.get("id");
    if (!variantId) return;

    var quantity = parseInt(data.get("quantity"), 10);
    if (!quantity || quantity < 1) quantity = 1;

    // A token shared by the parent line and its add-on lines. It is what makes
    // "remove the shirt, lose its engraving" possible, and what keeps two
    // separate purchases of the same product with different add-ons on
    // separate cart lines.
    var token = makeToken();

    var properties = fieldProperties(state);
    // Anything the theme itself put in the form (a bundled property, an
    // engraving field of its own) has to survive our interception.
    data.forEach(function (value, key) {
      var match = key.match(/^properties\[(.+)\]$/);
      if (match && !(match[1] in properties)) properties[match[1]] = value;
    });
    properties[PARENT_TOKEN_PROPERTY] = token;

    var items = [
      {
        id: Number(variantId),
        quantity: quantity,
        properties: properties,
      },
    ];

    var sellingPlan = data.get("selling_plan");
    if (sellingPlan) items[0].selling_plan = Number(sellingPlan);

    chosen.forEach(function (option) {
      var childProperties = {};
      childProperties[CHILD_TOKEN_PROPERTY] = token;
      items.push({
        id: option.variantId,
        // One add-on per unit of the parent: three engraved shirts need three
        // engravings, not one.
        quantity: quantity,
        properties: childProperties,
      });
    });

    setBusy(state, true);

    fetch(routeRoot() + "cart/add.js", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ items: items }),
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) {
            throw new Error(body && body.description ? body.description : "Add to cart failed");
          }
          return body;
        });
      })
      .then(function () {
        afterAdd();
      })
      .catch(function (error) {
        setBusy(state, false);
        window.alert(
          error && error.message ? error.message : state.t.addFailed,
        );
      });
  }

  function setBusy(state, busy) {
    if (!state.form) return;
    var buttons = state.form.querySelectorAll('[type="submit"], [name="add"]');
    buttons.forEach(function (button) {
      button.disabled = busy;
      button.classList.toggle("product-addons--busy", busy);
    });
  }

  /**
   * Hands control back to the theme after a successful add.
   *
   * Themes have no shared contract for "the cart changed", so this fires the
   * events the common ones listen for and falls back to the cart page. Going
   * to the cart is never wrong — it is what a theme without JavaScript does —
   * so it is the fallback rather than an error.
   */
  function afterAdd() {
    document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true }));
    document.dispatchEvent(new CustomEvent("cart:build", { bubbles: true }));

    if (window.Shopify && typeof window.Shopify.onCartUpdate === "function") {
      try {
        window.Shopify.onCartUpdate();
      } catch (error) {
        /* the theme's own handler; its failure is not ours to report */
      }
    }

    var drawer = document.querySelector(
      "cart-drawer, cart-notification, #CartDrawer, .js-drawer-cart",
    );
    if (drawer) {
      // The drawer theme will have re-rendered off the events above. Reloading
      // would throw away the drawer it just opened.
      window.location.reload();
      return;
    }

    window.location.href = routeRoot() + "cart";
  }

  /**
   * Removes add-on lines whose parent item is gone.
   *
   * Runs on every page load rather than hooking the theme's cart events,
   * because no such event exists across themes. It is a cheap self-heal: one
   * /cart.js read, and a write only when something is actually orphaned.
   */
  function reconcileCart() {
    fetch(routeRoot() + "cart.js", { headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (cart) {
        if (!cart || !cart.items) return;

        var liveParents = Object.create(null);
        cart.items.forEach(function (item) {
          var token = item.properties && item.properties[PARENT_TOKEN_PROPERTY];
          if (token) liveParents[token] = true;
        });

        var updates = {};
        var orphans = 0;
        cart.items.forEach(function (item) {
          var token = item.properties && item.properties[CHILD_TOKEN_PROPERTY];
          if (token && !liveParents[token]) {
            updates[item.key] = 0;
            orphans += 1;
          }
        });

        if (orphans === 0) return;

        return fetch(routeRoot() + "cart/update.js", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ updates: updates }),
        }).then(function () {
          // Only reload where the stale lines are on screen.
          if (/\/cart/.test(window.location.pathname)) window.location.reload();
        });
      })
      .catch(function () {
        // An orphaned add-on line is a cosmetic problem; never break the page
        // over the attempt to tidy it.
      });
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /**
   * Reads the strings Liquid passed in on the container.
   *
   * Nothing a customer can see is written in this file — the block puts every
   * one through the theme's translation filter and hands it over as a data
   * attribute, so the storefront half translates with the rest of the theme.
   * The fallbacks only matter if someone edits the block and forgets one.
   */
  function translations(root) {
    var data = root.dataset;
    return {
      required: data.tRequired || "Required",
      noThanks: data.tNoThanks || "No thanks",
      choose: data.tChoose || "Choose an option",
      total: data.tTotal || "Add-ons:",
      fillIn: data.tFillIn || "Please fill this in.",
      tick: data.tTick || "Please tick this to continue.",
      addFailed:
        data.tAddFailed || "Sorry, we could not add that to your cart.",
    };
  }

  function el(tag, className) {
    var node = document.createElement(tag);
    node.className = className;
    return node;
  }

  function makeToken() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return (
      Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    );
  }

  function moneyFormatter(root, currency) {
    var code = currency || root.dataset.currency || "USD";
    var locale = root.dataset.locale || undefined;
    var formatter;
    try {
      formatter = new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
      });
    } catch (error) {
      formatter = null;
    }
    return function (cents) {
      if (formatter) return formatter.format(cents / 100);
      return (cents / 100).toFixed(2) + " " + code;
    };
  }
})();
