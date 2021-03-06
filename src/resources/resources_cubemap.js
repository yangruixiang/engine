pc.extend(pc.resources, function () {

    function onTextureAssetChanged (asset, attribute, newValue, oldValue) {
        if (attribute !== 'resource') {
            return;
        }

        var cubemapAsset = this;
        var cubemap = cubemapAsset.resource;
        if (!cubemap)
            return;

        var sources = cubemap.getSource();
        var dirty = false;

        if (oldValue) {
            var oldImage = oldValue.getSource();
            for (var i = 0; i < sources.length; i++) {
                if (sources[i] === oldImage) {
                    sources[i] = newValue.getSource();
                    dirty = true;
                }
            }
        }

        if (dirty) {
            cubemap.setSource(sources);
            // fire 'change' event so dependent materials can update
            cubemapAsset.fire('change', cubemapAsset, 'resource', cubemap, cubemap);
        } else {
            asset.off('change', onTextureAssetChanged, cubemap);
        }
    }

    var CubemapResourceHandler = function (device, assets, loader) {
        this._device = device;
        this._assets = assets;
    };
    CubemapResourceHandler = pc.inherits(CubemapResourceHandler, pc.resources.ResourceHandler);

    CubemapResourceHandler.prototype.load = function (request, options) {
        var self = this;
        var promise = null;
        var asset = self._getAssetFromRequest(request);

        if (pc.string.startsWith(request.canonical, "asset://")) {
            // Loading from asset (platform)
            promise = new pc.promise.Promise(function (resolve, reject) {
                if (!asset) {
                    reject(pc.string.format("Can't load cubemap, asset {0} not found", request.canonical));
                }

                // load images before resolving the promise to make sure
                // we have them when we create the cubemap, otherwise self will
                // cause issues in cases like cubemaps used in materials which will be
                // rendered without textures in the Designer
                self._loadCubemapImages(asset.data).then(function (images) {
                    resolve(asset.data);
                }, function (error) {
                    reject(error);
                });

            });
        } else {
            // Loading from URL (engine-only)
            // Load cubemap data from a file (as opposed to from an asset)
            promise = new pc.promise.Promise(function (resolve, reject) {
                if (!self._isPrefilteredCubemapAsset(asset)) {
                    // load .json file
                    pc.net.http.get(request.canonical, function(response) {
                        var data = pc.extend({}, response);
                        var textures = response.textures;
                        if (textures.length) {
                            // Create and load all referenced textures
                            var assets = [];
                            textures.forEach(function (path) {
                                 var filename = pc.path.getBasename(path);
                                 var url = pc.path.join(pc.path.split(request.canonical)[0], path);
                                 assets.push(new pc.asset.Asset(filename, 'texture', {
                                     url: url
                                 }));
                            });

                            self._assets.load(assets).then(function (responses) {
                                // convert texture urls to asset ids
                                 data.textures = assets.map(function (asset) {
                                    return asset.id;
                                 });

                                 // Only when referenced assets are loaded do we resolve the cubemap load
                                resolve(data);
                             }, function (error) {
                                reject(error);
                             });
                        } else {
                            resolve(data);
                        }
                    }, {
                        error: function (error) {
                            reject('Could not load cubemap json: ' +  error);
                        }
                    });
                } else {
                    // load .dds file
                    var textureRequest = new pc.resources.TextureRequest(request.canonical);
                    self._assets.loader.request(textureRequest).then(function (resources) {
                        var data = pc.extend({}, asset.data);
                        // pass dds texture to data
                        data.prefiltered = resources[0];
                        // set this to true to avoid cubemap seams
                        data.prefiltered.fixCubemapSeams = true;
                        resolve(data);
                    }, function (error) {
                        reject('Could not load prefiltered cubemap: ' + error);
                    });
                }
            });
        }

        return promise;
    };

    CubemapResourceHandler.prototype.open = function (data, request, options) {
        var self = this;
        var cubemap = null;

        var asset = self._getAssetFromRequest(request);

        // create cubemap
        if (data.prefiltered) {
            cubemap = data.prefiltered;
        } else {
            if (request.result) {
                cubemap = request.result;
            } else {
                cubemap = new pc.Texture(self._device, {
                    format: pc.PIXELFORMAT_R8_G8_B8,
                    cubemap: true,
                    autoMipmap: true
                });
            }
        }

        self._updateCubemapData(asset, cubemap, data);

        asset.off('change', self._onCubemapAssetChanged, self);
        asset.on('change', self._onCubemapAssetChanged, self);

        return cubemap;
    };

    CubemapResourceHandler.prototype._isPrefilteredCubemapAsset = function (asset) {
        var url = asset.getFileUrl();
        if (url && pc.string.endsWith(url.toLowerCase(), '.dds')) {
            return true;
        }

        return false;
    };

    CubemapResourceHandler.prototype._onCubemapAssetChanged = function (asset, attribute, value, oldValue) {
        var self = this;
        var cubemap = asset.resource;
        if (!cubemap)
            return;

        // make sure we update the cubemap if the asset changes
        // if a cubemap changes we fire a 'change' event for
        // the cubemapAsset.resource property so materials who reference
        // this cubemap can update
        if (attribute === 'data') {
            var texturesChanged = false;
            if (!self._isPrefilteredCubemapAsset(asset)) {
                if (value.textures.length !== oldValue.textures.length) {
                    texturesChanged = true;
                } else {
                    for (var i = 0; i < value.textures.length; i++) {
                        if (value.textures[i] !== oldValue.textures[i]) {
                            texturesChanged = true;
                            break;
                        }
                    }
                }
            }

            if (texturesChanged) {
                self._loadCubemapImages(value).then(function () {
                    var old = asset.resource;
                    self._updateCubemapData(asset, cubemap, value);
                    asset.fire('change', asset, 'resource', asset.resource, old);
                });
            } else {
                self._updateCubemapData(asset, cubemap, value);
            }
        } else if (attribute === 'file') {
            // check if we need to clear prefiltered data
            // (if instead the 'file' changed then it will be automatically
            // reloaded by the asset registry)
            if (!value && oldValue) {
                // go back to plain cubemap
                self._loadCubemapImages(asset.data).then(function () {
                    cubemap = new pc.Texture(self._device, {
                        format: pc.PIXELFORMAT_R8_G8_B8,
                        cubemap: true,
                        autoMipmap: true
                    });

                    self._updateCubemapData(asset, cubemap, asset.data);
                    var old = asset.resource;
                    asset.resource = cubemap;
                    asset.fire('change', asset, 'resource', cubemap, old);
                });
            }
        }
    };

    // Checks if there are 6 non-null images with the correct dimensions in the specified array
    CubemapResourceHandler.prototype._areValidImages = function (images) {
        var result = images && images.length === 6;
        var error;

        if (result) {
            var width = images[0] ? images[0].width : null;
            var height = images[0] ? images[0].height : null;

            for (var i = 0; i < 6; i++) {
                if (!images[i]) {
                    result = false;
                    break;
                }


                if ((!images[i] instanceof HTMLCanvasElement) ||
                    (!images[i] instanceof HTMLImageElement) ||
                    (!images[i] instanceof HTMLVideoElement)) {
                    error = 'Cubemap source is not an instance of HTMLCanvasElement, HTMLImageElement or HTMLVideoElement.';
                    result = false;
                    break;
                }

                if (images[i].width !== width  || images[i].height !== height) {
                    error = 'Cubemap sources do not all share the same dimensions.';
                    result = false;
                    break;
                }
            }

        }

        if (error) {
            alert(error);
        }

        return result;
    };

    // Loads the images of the cubemap - Returns a promise
    CubemapResourceHandler.prototype._loadCubemapImages = function (data) {
        var self = this;
        var promise = new pc.promise.Promise(function (resolve, reject) {
            if (data.textures) {
                var assets = [];

                // check if we have 6 assets
                for (var i = 0; i < 6; i++) {
                    var id = parseInt(data.textures[i], 10);
                    if (id >= 0) {
                        var asset = self._assets.getAssetById(id);
                        if (asset) {
                            assets.push(asset);
                        } else {
                            reject(pc.string.format('Could not load cubemap - Texture {0} not found', data.textures[i]));
                            return;
                        }
                    } else {
                        // one texture is missing so just return
                        resolve(null);
                        return;
                    }
                }

                // update sources with the new images
                self._assets.load(assets).then(function (textures) {
                    // resolve with new images
                    resolve(textures.map(function (texture) {
                        return texture.getSource();
                    }));
                }, function (error) {
                    reject(error);
                });
            } else {
                // no textures provided so just return
                resolve(null);
            }
        });

        return promise;
    };


    // Updates cubemap data and reloads textures
    CubemapResourceHandler.prototype._updateCubemapData = function (cubemapAsset, cubemap, data) {
        if (cubemap.name !== data.name) {
            cubemap.name = data.name;
        }

        if (!this._isPrefilteredCubemapAsset(cubemapAsset)) {
            if (cubemap.minFilter !== data.minFilter) {
                cubemap.minFilter = data.minFilter;
            }

            if (cubemap.magFilter !== data.magFilter) {
                cubemap.magFilter = data.magFilter;
            }

            if (cubemap.addressU !== pc.ADDRESS_CLAMP_TO_EDGE) {
                cubemap.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
            }

            if (cubemap.addressV !== pc.ADDRESS_CLAMP_TO_EDGE) {
                cubemap.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
            }

            if (cubemap.anisotropy !== data.anisotropy) {
                cubemap.anisotropy = data.anisotropy;
            }

            // register change handlers for texture assets
            if (data.textures) {
                var images = [];
                for (var i = 0; i < 6; i++) {
                    if (data.textures[i]) {
                        var asset = this._assets.getAssetById(data.textures[i]);
                        if (asset) {
                            asset.off('change', onTextureAssetChanged, cubemapAsset);
                            asset.on('change', onTextureAssetChanged, cubemapAsset);

                            if (asset.resource) {
                                images.push(asset.resource.getSource());
                            }
                        }

                    }
                }

                if (this._areValidImages(images)) {
                    cubemap.setSource(images);
                }
            }
        }
    };

    CubemapResourceHandler.prototype._getAssetFromRequest = function (request) {
        if (pc.string.startsWith(request.canonical, "asset://")) {
            return this._assets.getAssetById(parseInt(request.canonical.slice(8)));
        } else {
            return this._assets.getAssetByUrl(request.canonical);
        }
    };

    var CubemapRequest = function (identifier) {
    };
    CubemapRequest = pc.inherits(CubemapRequest, pc.resources.ResourceRequest);
    CubemapRequest.prototype.type = "cubemap";
    CubemapRequest.prototype.Type = pc.Texture;

    return {
        CubemapResourceHandler: CubemapResourceHandler,
        CubemapRequest: CubemapRequest
    };
}())    ;
