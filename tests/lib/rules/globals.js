/**
 * @fileoverview Definitions for global Meteor variables based on environment
 * @author Dominik Ferber
 * @copyright 2015 Dominik Ferber. All rights reserved.
 * See LICENSE file in root directory for full license.
 */

// -----------------------------------------------------------------------------
// Requirements
// -----------------------------------------------------------------------------

import {SERVER, PACKAGE, NON_METEOR} from '../../../dist/util/environment'
const rule = require('../../../dist/rules/globals')
const RuleTester = require('eslint').RuleTester


// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

const ruleTester = new RuleTester()
ruleTester.run('globals', rule(() => ({env: SERVER})), {

  valid: ['Session.set("hi", true)'],
  invalid: []

})

ruleTester.run('globals', rule(() => ({env: PACKAGE})), {

  valid: [
    `
      /* eslint-meteor-env client, server */
      Session.set("hi", true)
    `,
    `
      /* eslint-meteor-env browser */
      Session.set("hi", true)
    `,
    `
      /* eslint-meteor-env server */
      Session.set("hi", true)
    `
  ],
  invalid: []

})

ruleTester.run('globals', rule(() => ({env: NON_METEOR})), {
  valid: ['Session.set("hi", true)'],
  invalid: []
})
