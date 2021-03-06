var _ = require('underscore'),
	async = require('async'),
	fs = require('fs'),
	qs = require('querystring'),
	auth = require('../lib/auth'),
	error = require('../lib/error'),
	gadgets = require('../gadgets/gadgets');

exports.registerController = function(app) {
	//Load service
	app.all('/dashboard/:service', auth.middleware(true, '/'), function(req, res, next) {
		if (/^[a-z]+$/.test(req.params.service) &&
			fs.existsSync('accounts/' + req.params.service + '.js'))
		{
			req.service = require('../accounts/' + req.params.service);
		//Yweather has no associated account
		} else if (req.params.service !== 'yweather') {
			return res.send(404);
		}

		next();
	});

	//Delete service on DELETE and on PATCH with reconnect=1
	app.all('/dashboard/:service', function(req, res, next) {
		//Skip if this is no delete or reconnect request
		if (req.method !== 'DELETE' && !(req.method === 'PATCH' && req.body.reconnect === '1')) {
			return next();
		}

		//Create mock account for Yweather, which does not have an associated account
		if (req.params.service === 'yweather') {
			req.service = {
				name: 'Yweather',
				gadgets: [
					{
						gadgetName: 'Yweather'
					}
				]
			};
		}

		//When possible, disconnect from service (e.g. revoke the access token)
		if (req.service.disconnect) {
			var accountData = req.user.accounts[req.service.name.toLowerCase()];
			req.service.disconnect(app, accountData, function(err) {
				if (err) {
					//Log errors, but remove the account from the database anyway
					app.error(error('Could not disconnect from ' + req.service.name, err));
				}

				deleteAccount();
			});
		} else {
			deleteAccount();
		}

		function deleteAccount() {
			var dbUpdate = {
				$unset: { }
			};

			//Delete account
			delete req.user.accounts[req.service.name.toLowerCase()];
			dbUpdate.$unset['accounts.' + req.service.name.toLowerCase()] = 1;

			//Delete gadgets that belonged to the account
			req.service.gadgets.forEach(function(gadget) {
				delete req.user.gadgets[gadget.gadgetName.toLowerCase()];
				dbUpdate.$unset['gadgets.' + gadget.gadgetName.toLowerCase()] = 1;
			});

			//Update database
			req.db.collection('users').updateById(req.user._id, dbUpdate, function(err) {
				if (error(err, next)) return;

				//Move on to connect anew when reconnecting
				if (req.body.reconnect === '1') {
					next();
				} else {
					res.send(200);
				}
			});
		}
	});

	//PUT or PATCH Yweather
	app.all('/dashboard/yweather', auth.middleware(true, '/'), function(req, res, next) {
		//Reject unsupported methods
		if (req.method !== 'PUT' && req.method !== 'PATCH') {
			return res.send(405);
		}

		//Attempt to find woeid for specified location
		gadgets.Yweather.getWoeid(app, req.body.location, function(err, place) {
			//Send 404 when place was not found
			if (err) return res.send(404);

			req.user.location = { area: place.name, woeid: place.woeid };

			//Set temperature unit to Fahrenheit for places in the US
			req.user.tempUnit = (place.countrycode == 'US' ? 'f' : 'c');

			//Pull weather data for new location
			var yweather = new gadgets.Yweather(req.user);

			//Remove data for old location
			req.user.gadgets.yweather.value = null;

			yweather.update(app, function(err) {
				//Precautiously abort when Yweather update failed,
				//for some woeids, there are no weather data
				if (err) return res.send(404);

				//Update database
				req.db.collection('users').updateById(req.user._id,
					{
						$set: {
							'gadgets.yweather': req.user.gadgets.yweather,
							location: req.user.location,
							tempUnit: req.user.tempUnit
						}
					},
					function(err) {
						if (error(err, next)) return;

						//Send new data
						res.json({
							yweather: {
								text: yweather.value,
								uri: yweather.uri,
								location: place.name
							}
						});
					}
				);
			});
		});
	});

	//Create new account on PUT or PATCH with ?reconnect=1 and
	//handle OAuth completion redirects
	app.all('/dashboard/:service', function(req, res, next) {
		//Allow dangerous method override through query parameters for redirects
		//from OAuth services
		if (req.method === 'GET' &&
			req.query._method &&
			req.query._method.toUpperCase() === 'PUT' &&
			req.query.complete ||
			req.user.accounts[req.params.service] !== undefined)
		{
			req.method = 'PUT';
		}

		//Reject unsupported methods
		if (req.method !== 'PUT' && !(req.method === 'PATCH' && req.body.reconnect === '1')) {
			return res.send(405);
		}

		//Provide URI for callbacks as used by OAuth
		var completeUri = app.set('uri') + 'dashboard/' + req.service.name.toLowerCase() + '?' +
			qs.stringify({
				_method: 'put',
				complete: 1
			});

		if (!req.query.complete) {
			//connect() can handle the request on its own or call setupAccount()
			req.service.connect(req, res, next, completeUri, setupAccount);
		} else {
			req.service.completeConnection(req, res, next, completeUri, setupAccount);
		}

		//Initialises the gadgets associated with the given account,
		//save the updated data and redirect the user to the dashboard
		//or respond with JSON to AJAX requests
		function setupAccount(err, account) {
			if (error(err, next)) return;

			//Add new account
			req.user.accounts[req.service.name.toLowerCase()] = account;

			//Gather updated gadget data for JSON response
			var gadgetData = { };

			//Set up all of this service's gadgets simultaneously
			async.each(req.service.gadgets, function(gadget, gadgetCb) {
				//Instantiate gadget
				gadget = new gadget(req.user);

				//Create task list for availability check and initial update
				var tasks = [ ];

				//If the gadget provides an availability check
				if (gadget.checkAvailability) {
					tasks.push(function(availabilityCb) {
						//Check for availability
						gadget.checkAvailability(app, function(available) {
							//Delete if unavailable
							if (!available) {
								delete req.user.gadgets[gadget.gadgetName.toLowerCase()];
								availabilityCb(new Error('Gadget unavailable'));
							} else {
								availabilityCb();
							}
						});
					});
				}

				//Run initial update
				tasks.push(function(updateCb) {
					gadget.update(app, function(err) {
						//Gather gadget data for JSON response
						gadgetData[gadget.gadgetName.toLowerCase()] = {
							text: gadget.value,
							uri: gadget.uri
						};

						updateCb();
					});
				});

				//Run availability check and initial update in sequence
				async.waterfall(tasks, function(err) {
					gadgetCb();
				});
			}, function() {
				var dbUpdate = { $set: { } };

				//Prepare gadget data for database
				_.each(gadgetData, function(info, name) {
					dbUpdate.$set['gadgets.' + name] = req.user.gadgets[name];
				});

				dbUpdate.$set['accounts.' + req.service.name.toLowerCase()] = account;

				//Save updated data
				req.db.collection('users').updateById(req.user._id, dbUpdate,
					function(err) {
					if (error(err, next)) return;

					//Redirect regular requests to dashboard
					if (!req.xhr) {
						res.redirect('/dashboard#settings');
					//Reply with JSON to AJAX requests
					} else {
						res.json(201, gadgetData);
					}
				});
			});
		}
	});
};